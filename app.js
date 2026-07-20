/* AuraDrive Core Application Logic - Obsidian Minimal Edition */

// Global Variables
let db = null;
let serverPeer = null;
let clientPeer = null;
let serverConnections = []; // Server's active client connections
let clientConnection = null; // Client's connection to server
let currentPath = '/';
let clientFilesystem = { folders: [], files: [] };
let activeTransfers = {}; // Track active chunks transfers: fileId -> { file, chunks, totalSize, parentPath, etc }
let toastTimeout = null;

// File Upload chunk size (256 KB)
const CHUNK_SIZE = 256 * 1024;

// Tab switcher state logic
let currentTab = 'client';

function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tab-client-btn').classList.toggle('active', tab === 'client');
    document.getElementById('tab-server-btn').classList.toggle('active', tab === 'server');
    document.getElementById('client-section').classList.toggle('active', tab === 'client');
    document.getElementById('server-section').classList.toggle('active', tab === 'server');
}

// Minimal Console Log Logger
function addLog(msg, type = 'system') {
    // Replaced DOM terminal log console with clean browser console output and notifications
    console.log(`[AuraDrive - ${type.toUpperCase()}] ${msg}`);
}

// ----------------------------------------------------
// INDEXEDDB DATABASE MANAGER
// ----------------------------------------------------
const DB_NAME = 'AuraDriveDB';
const DB_VERSION = 1;

const DB = {
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains('folders')) {
                    database.createObjectStore('folders', { keyPath: 'path' });
                }
                if (!database.objectStoreNames.contains('files')) {
                    database.createObjectStore('files', { keyPath: 'path' });
                }
            };
            
            request.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            
            request.onerror = (e) => {
                console.error("IndexedDB Open Error:", e.target.error);
                reject(e.target.error);
            };
        });
    },

    addFolder(path, name, parentPath) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('folders', 'readwrite');
            const store = tx.objectStore('folders');
            const folderObj = { path, name, parentPath, created: Date.now() };
            
            const request = store.put(folderObj);
            request.onsuccess = () => resolve(folderObj);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    addFile(path, name, parentPath, type, size, dataBlob) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readwrite');
            const store = tx.objectStore('files');
            const fileObj = { path, name, parentPath, type, size, data: dataBlob, created: Date.now() };
            
            const request = store.put(fileObj);
            request.onsuccess = () => resolve(fileObj);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getFile(path) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readonly');
            const store = tx.objectStore('files');
            const request = store.get(path);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    getAllFSMetadata() {
        return new Promise((resolve, reject) => {
            const fs = { folders: [], files: [] };
            let folderDone = false;
            let fileDone = false;

            const txFolders = db.transaction('folders', 'readonly');
            const storeFolders = txFolders.objectStore('folders');
            const requestFolders = storeFolders.getAll();
            requestFolders.onsuccess = (e) => {
                fs.folders = e.target.result || [];
                folderDone = true;
                if (fileDone) resolve(fs);
            };
            requestFolders.onerror = (e) => reject(e.target.error);

            const txFiles = db.transaction('files', 'readonly');
            const storeFiles = txFiles.objectStore('files');
            const requestFiles = storeFiles.openCursor();
            requestFiles.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const { path, name, parentPath, type, size, created } = cursor.value;
                    fs.files.push({ path, name, parentPath, type, size, created });
                    cursor.continue();
                } else {
                    fileDone = true;
                    if (folderDone) resolve(fs);
                }
            };
            requestFiles.onerror = (e) => reject(e.target.error);
        });
    },

    deleteItem(path, isFolder) {
        return new Promise(async (resolve, reject) => {
            try {
                if (!isFolder) {
                    const tx = db.transaction('files', 'readwrite');
                    const store = tx.objectStore('files');
                    const request = store.delete(path);
                    request.onsuccess = () => resolve();
                    request.onerror = (e) => reject(e.target.error);
                } else {
                    const foldersToDelete = [path];
                    const filesToDelete = [];

                    // Scan folders to find children
                    const txFoldersRead = db.transaction('folders', 'readonly');
                    const allFolders = await new Promise((res) => {
                        txFoldersRead.objectStore('folders').getAll().onsuccess = (e) => res(e.target.result || []);
                    });
                    
                    let index = 0;
                    while (index < foldersToDelete.length) {
                        const currentDir = foldersToDelete[index];
                        const children = allFolders.filter(f => f.parentPath === currentDir);
                        children.forEach(c => {
                            if (!foldersToDelete.includes(c.path)) {
                                foldersToDelete.push(c.path);
                            }
                        });
                        index++;
                    }

                    // Scan files to find nested files
                    const txFilesRead = db.transaction('files', 'readonly');
                    const allFiles = await new Promise((res) => {
                        const files = [];
                        txFilesRead.objectStore('files').openCursor().onsuccess = (e) => {
                            const cursor = e.target.result;
                            if (cursor) {
                                files.push({ path: cursor.value.path, parentPath: cursor.value.parentPath });
                                cursor.continue();
                            } else {
                                res(files);
                            }
                        };
                    });

                    foldersToDelete.forEach(folderPath => {
                        const matches = allFiles.filter(f => f.parentPath === folderPath);
                        matches.forEach(m => filesToDelete.push(m.path));
                    });

                    // Perform deletions
                    const txFoldersWrite = db.transaction('folders', 'readwrite');
                    foldersToDelete.forEach(p => txFoldersWrite.objectStore('folders').delete(p));

                    const txFilesWrite = db.transaction('files', 'readwrite');
                    filesToDelete.forEach(p => txFilesWrite.objectStore('files').delete(p));

                    await new Promise((res) => { txFoldersWrite.oncomplete = () => res(); });
                    await new Promise((res) => { txFilesWrite.oncomplete = () => res(); });
                    
                    resolve();
                }
            } catch (err) {
                reject(err);
            }
        });
    },

    clearAll() {
        return new Promise((resolve, reject) => {
            const txFolders = db.transaction('folders', 'readwrite');
            txFolders.objectStore('folders').clear();
            
            const txFiles = db.transaction('files', 'readwrite');
            txFiles.objectStore('files').clear();

            let foldersDone = false;
            let filesDone = false;

            txFolders.oncomplete = () => {
                foldersDone = true;
                if (filesDone) resolve();
            };
            txFiles.oncomplete = () => {
                filesDone = true;
                if (foldersDone) resolve();
            };
            txFolders.onerror = (e) => reject(e.target.error);
            txFiles.onerror = (e) => reject(e.target.error);
        });
    },

    calculateDatabaseSize() {
        return new Promise((resolve) => {
            let totalBytes = 0;
            const tx = db.transaction('files', 'readonly');
            const store = tx.objectStore('files');
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    totalBytes += cursor.value.size || 0;
                    cursor.continue();
                } else {
                    resolve(totalBytes);
                }
            };
        });
    }
};

// ----------------------------------------------------
// SERVER NODE LOGIC (RECEIVER)
// ----------------------------------------------------

// Render local files for the receiver view
async function refreshServerExplorer() {
    const listEl = document.getElementById('server-explorer-list');
    listEl.innerHTML = '';
    
    try {
        const fs = await DB.getAllFSMetadata();
        const sizeBytes = await DB.calculateDatabaseSize();
        document.getElementById('storage-size-val').innerText = formatBytes(sizeBytes);
        document.getElementById('server-file-count').innerText = `${fs.files.length} file(s)`;

        if (fs.files.length === 0 && fs.folders.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="hard-drive"></i>
                    <p>No files hosted yet.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        fs.files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'server-file-item';
            
            const fileIcon = getFileIconName(file.name);
            const iconClass = getFileIconClass(file.name);

            item.innerHTML = `
                <div class="file-info-group">
                    <div class="card-icon ${iconClass}">
                        <i data-lucide="${fileIcon}"></i>
                    </div>
                    <div style="overflow: hidden;">
                        <div class="server-filename" title="${file.path}">${file.name}</div>
                        <div class="server-filemeta">${formatBytes(file.size)} • Path: ${file.parentPath}</div>
                    </div>
                </div>
                <div class="file-action-group">
                    <button class="btn-icon" onclick="downloadServerFile('${file.path}', '${file.name}')" title="Download Locally">
                        <i data-lucide="download"></i>
                    </button>
                    <button class="btn-icon" onclick="deleteServerItem('${file.path}', false)" title="Delete File">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            `;
            listEl.appendChild(item);
        });
        
        lucide.createIcons();
    } catch (err) {
        addLog(`Error loading server database: ${err.message}`, 'err');
    }
}

// Download file on server's physical device
async function downloadServerFile(path, filename) {
    try {
        const fileObj = await DB.getFile(path);
        if (fileObj && fileObj.data) {
            triggerDownload(fileObj.data, filename);
            addLog(`Downloaded locally: ${filename}`, 'success');
        } else {
            showToast('File not found in storage', 'error');
        }
    } catch (err) {
        addLog(`Download error: ${err.message}`, 'err');
    }
}

// Trigger browser download
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Delete item directly on server
async function deleteServerItem(path, isFolder) {
    if (confirm(`Are you sure you want to delete ${isFolder ? 'folder' : 'file'}?`)) {
        try {
            await DB.deleteItem(path, isFolder);
            addLog(`Deleted: ${path}`, 'warn');
            refreshServerExplorer();
            broadcastFSUpdate();
        } catch (err) {
            addLog(`Deletion error: ${err.message}`, 'err');
        }
    }
}

// Broadcast updated directory structure to all authenticated clients
async function broadcastFSUpdate() {
    try {
        const fs = await DB.getAllFSMetadata();
        serverConnections.forEach(conn => {
            if (conn.authenticated) {
                conn.send({
                    type: 'fs-update',
                    filesystem: fs
                });
            }
        });
    } catch (err) {
        addLog(`Broadcast update error: ${err.message}`, 'err');
    }
}

// Update connected client list in Server Admin UI
function updateConnectedClientsUI() {
    const ul = document.getElementById('connected-clients-ul');
    const countSpan = document.getElementById('client-count');
    
    const authenticatedConns = serverConnections.filter(c => c.authenticated);
    if (countSpan) {
        countSpan.innerText = authenticatedConns.length;
    }
    
    if (!ul) return; // Guard against missing UL in minimal layouts
    
    if (authenticatedConns.length === 0) {
        ul.innerHTML = '<li class="no-clients">No active connections</li>';
        return;
    }
    
    ul.innerHTML = '';
    authenticatedConns.forEach(conn => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span><strong>${conn.username}</strong></span>
            <button class="btn-icon" onclick="disconnectClient('${conn.peer}')" title="Force Disconnect">
                <i data-lucide="x-circle"></i>
            </button>
        `;
        ul.appendChild(li);
    });
    lucide.createIcons();
}

// Disconnect a client connection forcefully
function disconnectClient(clientPeerId) {
    const index = serverConnections.findIndex(c => c.peer === clientPeerId);
    if (index !== -1) {
        addLog(`Forced disconnect of client: ${serverConnections[index].username}`, 'warn');
        serverConnections[index].close();
        serverConnections.splice(index, 1);
        updateConnectedClientsUI();
    }
}

// Clear all storage on server
async function clearServerDatabase() {
    if (confirm("Wipe all files from server? This cannot be undone.")) {
        try {
            await DB.clearAll();
            addLog("All virtual storage deleted from server node.", "warn");
            refreshServerExplorer();
            broadcastFSUpdate();
            showToast("Server storage wiped", "success");
        } catch (err) {
            addLog(`Error clearing database: ${err.message}`, 'err');
        }
    }
}

// Edit Credentials form trigger
function editServerCredentials() {
    document.getElementById('credentials-modal').classList.remove('hidden');
    document.getElementById('server-username').value = localStorage.getItem('server_username') || '';
    document.getElementById('server-password').value = localStorage.getItem('server_password') || '';
}

function closeCredentialsModal() {
    document.getElementById('credentials-modal').classList.add('hidden');
}

// Handle submit of Credentials form
function handleServerCredentialsSetup(e) {
    e.preventDefault();
    const username = document.getElementById('server-username').value.trim();
    const password = document.getElementById('server-password').value.trim();
    
    if (!username || !password) {
        showToast('Please enter both username and password', 'error');
        return;
    }
    
    localStorage.setItem('server_username', username);
    localStorage.setItem('server_password', password);
    
    initServerUI(username);
    
    // Restart Server if it was active to apply new Peer ID
    const isPowerOn = document.getElementById('server-power-switch').checked;
    if (isPowerOn) {
        toggleServer(false);
        toggleServer(true);
    }
    
    closeCredentialsModal();
    showToast('Credentials updated', 'success');
    addLog(`Server node configured for username: ${username}`, 'system');
}

// Render server panel with saved details
function initServerUI(username) {
    document.getElementById('active-server-username').innerText = username;
    document.getElementById('active-server-peerid').innerText = `p2p-cloud-drive-${username.toLowerCase()}`;
    
    // Autofill client target server as well
    document.getElementById('connect-username').value = username;
}

// Toggle Server PeerJS Instance ON / OFF
function toggleServer(shouldStart) {
    const badge = document.getElementById('server-status-badge');
    const badgeText = badge.querySelector('.badge-text');
    const serverPowerLbl = document.getElementById('server-power-status-lbl');
    
    if (shouldStart) {
        const username = localStorage.getItem('server_username');
        const password = localStorage.getItem('server_password');
        
        if (!username || !password) {
            showToast("Credentials not found", "error");
            document.getElementById('server-power-switch').checked = false;
            return;
        }

        badge.className = "badge badge-initializing";
        badgeText.innerText = "Initializing...";
        addLog("Initializing PeerJS connection...", "system");
        
        // Setup Server Peer
        const serverPeerId = `p2p-cloud-drive-${username.toLowerCase()}`;
        
        serverPeer = new Peer(serverPeerId, {
            debug: 2,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        });
        
        serverPeer.on('open', (id) => {
            badge.className = "badge badge-online";
            badgeText.innerText = "Online";
            serverPowerLbl.innerText = "Storage node is online & broadcasting.";
            addLog(`Storage node online with PeerID: ${id}`, "success");
            localStorage.setItem('server_active_state', 'true');
        });
        
        serverPeer.on('connection', (conn) => {
            addLog(`Incoming connection request from ${conn.peer}...`, "system");
            
            conn.authenticated = false;
            conn.username = '';
            
            conn.on('open', () => {
                serverConnections.push(conn);
            });
            
            conn.on('data', async (data) => {
                try {
                    // 1. Handshake Authentication
                    if (!conn.authenticated) {
                        if (data.type === 'auth') {
                            const expectedPass = localStorage.getItem('server_password');
                            if (data.password === expectedPass) {
                                conn.authenticated = true;
                                conn.username = data.username || 'Anonymous Sender';
                                addLog(`Client successfully authenticated: ${conn.username} (${conn.peer})`, "success");
                                
                                const fs = await DB.getAllFSMetadata();
                                conn.send({
                                    type: 'auth-success',
                                    filesystem: fs
                                });
                                updateConnectedClientsUI();
                            } else {
                                addLog(`Client authentication failed: invalid password from ${conn.peer}`, "err");
                                conn.send({
                                    type: 'auth-fail',
                                    message: 'Invalid password credentials.'
                                });
                                setTimeout(() => conn.close(), 1000);
                            }
                        }
                        return;
                    }
                    
                    // 2. Handle Authorized Requests
                    switch (data.type) {
                        case 'get-fs':
                            const fs = await DB.getAllFSMetadata();
                            conn.send({ type: 'fs-update', filesystem: fs });
                            break;
                            
                        case 'create-folder':
                            await DB.addFolder(data.path, data.name, data.parentPath);
                            addLog(`Folder created by client: ${data.path}`, "system");
                            broadcastFSUpdate();
                            refreshServerExplorer();
                            break;
                            
                        case 'delete-item':
                            await DB.deleteItem(data.path, data.isFolder);
                            addLog(`Deleted by client: ${data.path} (${data.isFolder ? 'Folder' : 'File'})`, "warn");
                            broadcastFSUpdate();
                            refreshServerExplorer();
                            break;
                            
                        case 'upload-start':
                            // Initialize active transfer buffer
                            activeTransfers[data.fileId] = {
                                name: data.name,
                                fileType: data.fileType,
                                size: data.size,
                                parentPath: data.parentPath,
                                path: data.path,
                                totalChunks: data.totalChunks,
                                chunks: []
                            };
                            conn.send({ type: 'upload-ack', fileId: data.fileId, chunkIndex: -1 });
                            break;
                            
                        case 'upload-chunk':
                            const transfer = activeTransfers[data.fileId];
                            if (transfer) {
                                transfer.chunks[data.chunkIndex] = data.chunkData;
                                
                                // Acknowledge receipt
                                conn.send({ type: 'upload-ack', fileId: data.fileId, chunkIndex: data.chunkIndex });
                                
                                // Check if completed
                                if (transfer.chunks.filter(c => c !== undefined).length === transfer.totalChunks) {
                                    addLog(`Assembling complete file: ${transfer.name}`, 'system');
                                    
                                    // Merge chunks into a single Blob
                                    const fileBlob = new Blob(transfer.chunks, { type: transfer.fileType });
                                    
                                    // Save in database
                                    await DB.addFile(transfer.path, transfer.name, transfer.parentPath, transfer.fileType, transfer.size, fileBlob);
                                    addLog(`Saved file to DB: ${transfer.path}`, 'success');
                                    
                                    // Auto-download file on server device
                                    triggerDownload(fileBlob, transfer.name);
                                    addLog(`Automatically downloaded: ${transfer.name}`, 'success');
                                    
                                    // Clean up
                                    delete activeTransfers[data.fileId];
                                    
                                    // Update folder lists
                                    broadcastFSUpdate();
                                    refreshServerExplorer();
                                }
                            }
                            break;
                            
                        case 'upload-cancel':
                            if (activeTransfers[data.fileId]) {
                                addLog(`Upload cancelled by client: ${activeTransfers[data.fileId].name}`, 'warn');
                                delete activeTransfers[data.fileId];
                            }
                            break;
                            
                        case 'download-req':
                            addLog(`Client requested download: ${data.path}`, 'system');
                            const fileObj = await DB.getFile(data.path);
                            if (fileObj && fileObj.data) {
                                sendFileToClient(conn, fileObj);
                            } else {
                                addLog(`Requested file not found: ${data.path}`, 'err');
                                conn.send({ type: 'download-fail', path: data.path, message: 'File not found on server' });
                            }
                            break;
                            
                        case 'download-ack':
                            handleClientDownloadAck(conn, data);
                            break;
                    }
                } catch (err) {
                    addLog(`Error parsing client message: ${err.message}`, "err");
                }
            });
            
            conn.on('close', () => {
                addLog(`Connection closed for client: ${conn.username || conn.peer}`, "warn");
                const index = serverConnections.indexOf(conn);
                if (index !== -1) {
                    serverConnections.splice(index, 1);
                }
                updateConnectedClientsUI();
            });
            
            conn.on('error', (err) => {
                addLog(`Connection error on client ${conn.peer}: ${err.message}`, "err");
            });
        });
        
        serverPeer.on('error', (err) => {
            badge.className = "badge badge-offline";
            badgeText.innerText = "Offline";
            document.getElementById('server-power-switch').checked = false;
            
            if (err.type === 'unavailable-id') {
                showToast("Server username already online", "error");
                addLog("Startup failed: Server username is already active elsewhere.", "err");
            } else {
                showToast(`Server error: ${err.message}`, "error");
                addLog(`Startup error: ${err.message}`, "err");
            }
        });
        
    } else {
        badge.className = "badge badge-offline";
        badgeText.innerText = "Offline";
        serverPowerLbl.innerText = "Turn server ON to allow client connections.";
        addLog("Stopping storage node server...", "system");
        
        // Close connections
        serverConnections.forEach(c => c.close());
        serverConnections = [];
        updateConnectedClientsUI();
        
        if (serverPeer) {
            serverPeer.destroy();
            serverPeer = null;
        }
        
        localStorage.setItem('server_active_state', 'false');
        addLog("Storage node offline.", "system");
    }
}

// ----------------------------------------------------
// SERVER FILE DOWNLOAD TO CLIENT SENDER CHUNKING
// ----------------------------------------------------
let activeDownloadsOnServer = {}; // fileId -> { arrayBuffer, chunksCount, currentChunk, path, name }

async function sendFileToClient(conn, fileObj) {
    try {
        const fileId = generateUUID();
        const arrayBuffer = await fileObj.data.arrayBuffer();
        const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
        
        activeDownloadsOnServer[fileId] = {
            conn: conn,
            arrayBuffer: arrayBuffer,
            totalChunks: totalChunks,
            currentChunk: 0,
            path: fileObj.path,
            name: fileObj.name,
            size: fileObj.size,
            type: fileObj.type
        };
        
        // Notify client download starts
        conn.send({
            type: 'download-start',
            fileId: fileId,
            path: fileObj.path,
            name: fileObj.name,
            size: fileObj.size,
            fileType: fileObj.type,
            totalChunks: totalChunks
        });
        
        // Start sending first chunk
        sendNextDownloadChunk(fileId);
    } catch (err) {
        addLog(`Error processing server file buffer: ${err.message}`, 'err');
        conn.send({ type: 'download-fail', path: fileObj.path, message: 'File read failure on server' });
    }
}

function sendNextDownloadChunk(fileId) {
    const dl = activeDownloadsOnServer[fileId];
    if (!dl) return;
    
    const start = dl.currentChunk * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, dl.arrayBuffer.byteLength);
    const chunkData = dl.arrayBuffer.slice(start, end);
    
    dl.conn.send({
        type: 'download-chunk',
        fileId: fileId,
        chunkIndex: dl.currentChunk,
        chunkData: chunkData
    });
}

// Handle Download Acknowledgement from Client
function handleClientDownloadAck(conn, data) {
    const dl = activeDownloadsOnServer[data.fileId];
    if (!dl) return;
    
    if (data.chunkIndex === dl.currentChunk) {
        dl.currentChunk++;
        if (dl.currentChunk < dl.totalChunks) {
            sendNextDownloadChunk(data.fileId);
        } else {
            addLog(`Download transmission complete for client: ${dl.name}`, 'success');
            delete activeDownloadsOnServer[data.fileId];
        }
    }
}

// ----------------------------------------------------
// CLIENT SENDER LOGIC (CONNECTS TO STORAGE NODE)
// ----------------------------------------------------
function handleClientConnect(e) {
    e.preventDefault();
    
    const username = document.getElementById('connect-username').value.trim();
    const password = document.getElementById('connect-password').value.trim();
    const remember = document.getElementById('connect-remember').checked;
    
    if (!username || !password) {
        showToast("Please enter server credentials", "error");
        return;
    }
    
    const statusDiv = document.getElementById('client-connection-status');
    const statusText = document.getElementById('client-status-text');
    
    statusDiv.classList.remove('hidden');
    statusText.innerText = "Connecting to network...";
    
    // Initialize Client Peer
    if (clientPeer) {
        clientPeer.destroy();
    }
    
    clientPeer = new Peer({
        debug: 2,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        }
    });
    
    clientPeer.on('open', (clientId) => {
        statusText.innerText = `Establishing link to storage...`;
        
        // Connect to server
        const targetServerId = `p2p-cloud-drive-${username.toLowerCase()}`;
        
        clientConnection = clientPeer.connect(targetServerId);
        
        clientConnection.on('open', () => {
            statusText.innerText = "Authenticating...";
            // Send Credentials
            clientConnection.send({
                type: 'auth',
                username: `Client (${clientId.substring(0,4)})`,
                password: password
            });
        });
        
        clientConnection.on('data', (data) => {
            if (data.type === 'auth-success') {
                statusDiv.classList.add('hidden');
                showToast("Connected to storage node!", "success");
                
                // Save connection in localStorage if remember is true
                if (remember) {
                    localStorage.setItem('client_username', username);
                    localStorage.setItem('client_password', password);
                    localStorage.setItem('client_remember', 'true');
                } else {
                    localStorage.removeItem('client_username');
                    localStorage.removeItem('client_password');
                    localStorage.removeItem('client_remember');
                }
                
                // Show Drive Interface
                document.getElementById('client-auth-view').classList.add('hidden');
                document.getElementById('client-drive-view').classList.remove('hidden');
                document.getElementById('connected-server-name').innerText = username;
                document.getElementById('connected-peer-id').innerText = targetServerId;
                
                // Setup drive file explorer path and filesystem
                currentPath = '/';
                clientFilesystem = data.filesystem;
                renderExplorer();
            }
            
            else if (data.type === 'auth-fail') {
                statusDiv.classList.add('hidden');
                showToast(`Auth failed: ${data.message}`, "error");
                clientConnection.close();
            }
            
            else if (data.type === 'fs-update') {
                clientFilesystem = data.filesystem;
                renderExplorer();
            }
            
            else if (data.type === 'upload-ack') {
                handleServerUploadAck(data);
            }
            
            else if (data.type === 'download-start') {
                initClientDownload(data);
            }
            
            else if (data.type === 'download-chunk') {
                handleServerDownloadChunk(data);
            }
            
            else if (data.type === 'download-fail') {
                showToast(data.message, "error");
                hideProgressPanel();
            }
        });
        
        clientConnection.on('close', () => {
            showToast("Connection to server closed", "error");
            handleClientDisconnectUI();
        });
        
        clientConnection.on('error', (err) => {
            showToast(`Connection error: ${err.message}`, "error");
            statusDiv.classList.add('hidden');
        });
    });
    
    clientPeer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
            showToast("Server node is offline", "error");
        } else {
            showToast(`Peer error: ${err.message}`, "error");
        }
        statusDiv.classList.add('hidden');
    });
}

function handleClientDisconnect() {
    if (clientConnection) {
        clientConnection.close();
    }
    if (clientPeer) {
        clientPeer.destroy();
        clientPeer = null;
    }
    
    localStorage.removeItem('client_remember');
    localStorage.removeItem('client_username');
    localStorage.removeItem('client_password');
    
    handleClientDisconnectUI();
}

function handleClientDisconnectUI() {
    document.getElementById('client-auth-view').classList.remove('hidden');
    document.getElementById('client-drive-view').classList.add('hidden');
    document.getElementById('client-connection-status').classList.add('hidden');
    hideProgressPanel();
    
    clientConnection = null;
    clientFilesystem = { folders: [], files: [] };
}

// Copy Server Peer ID inside dashboard
function copyServerPeerId() {
    const el = document.getElementById('active-server-peerid');
    if (!el) return;
    navigator.clipboard.writeText(el.innerText);
    showToast("Server Peer ID copied", "success");
    
    const container = document.getElementById('active-server-peerid-container');
    if (container) {
        const originalHTML = container.innerHTML;
        container.innerHTML = `<span class="node-id" style="color: var(--success); cursor: default;">Copied!</span>`;
        setTimeout(() => {
            container.innerHTML = originalHTML;
        }, 1000);
    }
}

// ----------------------------------------------------
// DRIVE EXPLORER RENDERING LOGIC
// ----------------------------------------------------
function renderExplorer() {
    const view = document.getElementById('explorer-view');
    
    // Restart animation reflow to smooth out navigation transitions
    view.classList.remove('animate-fade-in');
    void view.offsetWidth; // Force CSS reflow
    view.classList.add('animate-fade-in');
    
    view.innerHTML = '';
    
    // Generate Breadcrumbs
    renderBreadcrumbs();
    
    // Filter folders and files for current path
    const folders = clientFilesystem.folders.filter(f => f.parentPath === currentPath);
    const files = clientFilesystem.files.filter(f => f.parentPath === currentPath);
    
    if (folders.length === 0 && files.length === 0) {
        view.innerHTML = `
            <div class="empty-state card">
                <i data-lucide="folder-open"></i>
                <h3>Empty Cloud</h3>
                <p>Upload files or create folders.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }
    
    // Render Folders
    folders.sort((a,b) => a.name.localeCompare(b.name)).forEach(folder => {
        const fCard = document.createElement('div');
        fCard.className = 'explorer-card folder-card';
        fCard.onclick = () => navigateToPath(folder.path);
        
        fCard.innerHTML = `
            <div class="explorer-card-header">
                <div class="card-icon">
                    <i data-lucide="folder"></i>
                </div>
                <div class="card-dropdown" onclick="event.stopPropagation()">
                    <button class="btn-icon" onclick="deleteDriveItem('${folder.path}', true)" title="Delete Folder">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
            <div class="explorer-card-body">
                <div class="explorer-card-title" title="${folder.name}">${folder.name}</div>
                <div class="explorer-card-meta">Folder</div>
            </div>
        `;
        view.appendChild(fCard);
    });
    
    // Render Files
    files.sort((a,b) => a.name.localeCompare(b.name)).forEach(file => {
        const fCard = document.createElement('div');
        fCard.className = 'explorer-card file-card';
        
        const fileIcon = getFileIconName(file.name);
        const iconClass = getFileIconClass(file.name);
        
        fCard.innerHTML = `
            <div class="explorer-card-header">
                <div class="card-icon ${iconClass}">
                    <i data-lucide="${fileIcon}"></i>
                </div>
                <div class="card-dropdown" onclick="event.stopPropagation()">
                    <button class="btn-icon" onclick="deleteDriveItem('${file.path}', false)" title="Delete File">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
            <div class="explorer-card-body" onclick="requestFileDownload('${file.path}', '${file.name}')">
                <div class="explorer-card-title" title="${file.name}">${file.name}</div>
                <div class="explorer-card-meta">${formatBytes(file.size)} • Get</div>
            </div>
        `;
        view.appendChild(fCard);
    });
    
    lucide.createIcons();
}

function navigateToPath(path) {
    currentPath = path;
    renderExplorer();
}

function renderBreadcrumbs() {
    const list = document.getElementById('breadcrumbs');
    list.innerHTML = '';
    
    if (currentPath === '/') return;
    
    const parts = currentPath.split('/').filter(p => p !== '');
    let builtPath = '';
    
    parts.forEach((part, i) => {
        builtPath += '/' + part;
        const targetPath = builtPath; // Capture closure value
        
        const node = document.createElement('div');
        node.className = 'breadcrumb-node';
        node.innerHTML = `<span onclick="navigateToPath('${targetPath}')">${part}</span>`;
        list.appendChild(node);
    });
}

// ----------------------------------------------------
// CREATE VIRTUAL FOLDER
// ----------------------------------------------------
function showCreateFolderModal() {
    document.getElementById('new-folder-name').value = '';
    document.getElementById('folder-modal').classList.remove('hidden');
    document.getElementById('new-folder-name').focus();
}

function closeFolderModal() {
    document.getElementById('folder-modal').classList.add('hidden');
}

function submitCreateFolder() {
    const folderName = document.getElementById('new-folder-name').value.trim();
    if (!folderName) {
        showToast("Enter a folder name", "error");
        return;
    }
    
    if (folderName.includes('/') || folderName.includes('\\')) {
        showToast("Folder name invalid", "error");
        return;
    }
    
    const folderPath = currentPath === '/' ? '/' + folderName : currentPath + '/' + folderName;
    const duplicate = clientFilesystem.folders.find(f => f.path === folderPath);
    if (duplicate) {
        showToast("Folder already exists", "error");
        return;
    }
    
    if (clientConnection && clientConnection.open) {
        clientConnection.send({
            type: 'create-folder',
            path: folderPath,
            name: folderName,
            parentPath: currentPath
        });
        closeFolderModal();
        showToast(`Folder created`, "success");
    } else {
        showToast("Connection offline", "error");
    }
}

// ----------------------------------------------------
// CLIENT FILE UPLOAD WITH CHUNKING
// ----------------------------------------------------
let activeUpload = null; // { fileId, file, arrayBuffer, totalChunks, currentChunk, startTime }

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!clientConnection || !clientConnection.open) {
        showToast("Not connected to server", "error");
        return;
    }
    
    document.getElementById('drive-file-upload').value = '';
    
    // Check duplication
    const filePath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
    const duplicate = clientFilesystem.files.find(f => f.path === filePath);
    if (duplicate) {
        if (!confirm(`Overwrite duplicate file "${file.name}"?`)) {
            return;
        }
    }
    
    showToast("Starting upload...", "info");
    
    const fileId = generateUUID();
    const reader = new FileReader();
    
    reader.onload = function(evt) {
        const arrayBuffer = evt.target.result;
        const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
        
        activeUpload = {
            fileId: fileId,
            file: file,
            arrayBuffer: arrayBuffer,
            totalChunks: totalChunks,
            currentChunk: -1, // -1 means handshake state
            startTime: Date.now()
        };
        
        showProgressPanel(file.name);
        updateProgressUI(0, "Initiating...");
        
        clientConnection.send({
            type: 'upload-start',
            fileId: fileId,
            name: file.name,
            fileType: file.type,
            size: file.size,
            parentPath: currentPath,
            path: filePath,
            totalChunks: totalChunks
        });
    };
    
    reader.readAsArrayBuffer(file);
}

function handleServerUploadAck(data) {
    if (!activeUpload || activeUpload.fileId !== data.fileId) return;
    
    activeUpload.currentChunk = data.chunkIndex + 1;
    
    if (activeUpload.currentChunk < activeUpload.totalChunks) {
        sendNextUploadChunk();
    } else {
        showToast("Upload completed!", "success");
        hideProgressPanel();
        activeUpload = null;
    }
}

function sendNextUploadChunk() {
    const up = activeUpload;
    const start = up.currentChunk * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, up.arrayBuffer.byteLength);
    const chunkData = up.arrayBuffer.slice(start, end);
    
    const pct = Math.round((start / up.arrayBuffer.byteLength) * 100);
    const elapsedSeconds = (Date.now() - up.startTime) / 1000;
    const speed = elapsedSeconds > 0 ? (start / elapsedSeconds) : 0;
    
    updateProgressUI(
        pct, 
        `${pct}% • ${formatBytes(speed)}/s`
    );
    
    clientConnection.send({
        type: 'upload-chunk',
        fileId: up.fileId,
        chunkIndex: up.currentChunk,
        chunkData: chunkData
    });
}

function cancelUpload() {
    if (activeUpload) {
        if (clientConnection && clientConnection.open) {
            clientConnection.send({
                type: 'upload-cancel',
                fileId: activeUpload.fileId
            });
        }
        showToast("Upload cancelled", "warn");
        hideProgressPanel();
        activeUpload = null;
    }
}

// ----------------------------------------------------
// CLIENT FILE DOWNLOAD WITH CHUNKING
// ----------------------------------------------------
let activeDownload = null; // { fileId, name, size, fileType, totalChunks, chunks: [], startTime }

function requestFileDownload(path, name) {
    if (!clientConnection || !clientConnection.open) {
        showToast("Not connected to server", "error");
        return;
    }
    
    showToast("Requesting file...", "info");
    clientConnection.send({
        type: 'download-req',
        path: path
    });
}

function initClientDownload(data) {
    activeDownload = {
        fileId: data.fileId,
        name: data.name,
        size: data.size,
        fileType: data.fileType,
        totalChunks: data.totalChunks,
        chunks: [],
        startTime: Date.now()
    };
    
    showProgressPanel(`Downloading: ${data.name}`);
    updateProgressUI(0, "Downloading...");
}

function handleServerDownloadChunk(data) {
    if (!activeDownload || activeDownload.fileId !== data.fileId) return;
    
    const dl = activeDownload;
    dl.chunks[data.chunkIndex] = data.chunkData;
    
    const chunksReceived = dl.chunks.filter(c => c !== undefined).length;
    const pct = Math.round((chunksReceived / dl.totalChunks) * 100);
    const bytesReceived = chunksReceived * CHUNK_SIZE;
    const elapsedSeconds = (Date.now() - dl.startTime) / 1000;
    const speed = elapsedSeconds > 0 ? (bytesReceived / elapsedSeconds) : 0;
    
    updateProgressUI(
        pct,
        `${pct}% • ${formatBytes(speed)}/s`
    );
    
    clientConnection.send({
        type: 'download-ack',
        fileId: dl.fileId,
        chunkIndex: data.chunkIndex
    });
    
    if (chunksReceived === dl.totalChunks) {
        showToast("Download completed!", "success");
        hideProgressPanel();
        
        const fileBlob = new Blob(dl.chunks, { type: dl.fileType });
        triggerDownload(fileBlob, dl.name);
        
        activeDownload = null;
    }
}

// ----------------------------------------------------
// DELETE OPERATIONS (CLIENT)
// ----------------------------------------------------
function deleteDriveItem(path, isFolder) {
    if (confirm(`Delete ${isFolder ? 'folder' : 'file'}?`)) {
        if (clientConnection && clientConnection.open) {
            clientConnection.send({
                type: 'delete-item',
                path: path,
                isFolder: isFolder
            });
            showToast("Deleting...", "warn");
        } else {
            showToast("Connection offline", "error");
        }
    }
}

// ----------------------------------------------------
// UI UTILITIES & FORMATTERS
// ----------------------------------------------------
function showProgressPanel(filename) {
    document.getElementById('progress-filename').innerText = filename;
    document.getElementById('upload-progress-panel').classList.remove('hidden');
}

function updateProgressUI(pct, metaText) {
    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-meta').innerText = metaText;
}

function hideProgressPanel() {
    document.getElementById('upload-progress-panel').classList.add('hidden');
}

function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast-notification');
    const label = document.getElementById('toast-msg');
    
    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }
    
    toast.className = `toast toast-${type} animate-scale-in`;
    label.innerText = msg;
    toast.classList.remove('hidden');
    
    toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getFileIconName(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'];
    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'];
    const zipExts = ['zip', 'rar', 'tar', 'gz', '7z'];
    
    if (imageExts.includes(ext)) return 'image';
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'music';
    if (docExts.includes(ext)) return 'file-text';
    if (zipExts.includes(ext)) return 'file-archive';
    return 'file';
}

function getFileIconClass(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'];
    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'];
    const zipExts = ['zip', 'rar', 'tar', 'gz', '7z'];
    
    if (imageExts.includes(ext)) return 'icon-image';
    if (videoExts.includes(ext)) return 'icon-video';
    if (audioExts.includes(ext)) return 'icon-audio';
    if (docExts.includes(ext)) return 'icon-doc';
    if (zipExts.includes(ext)) return 'icon-zip';
    return '';
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Setup Drag & Drop listeners
function initDragAndDrop() {
    const driveView = document.getElementById('client-drive-view');
    const dropZone = document.getElementById('drop-zone');
    
    if (!driveView || !dropZone) return;
    
    window.addEventListener('dragover', (e) => {
        if (driveView.classList.contains('hidden')) return;
        e.preventDefault();
        dropZone.classList.remove('hidden');
    });
    
    window.addEventListener('dragenter', (e) => {
        if (driveView.classList.contains('hidden')) return;
        e.preventDefault();
    });
    
    window.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null || e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
            dropZone.classList.add('hidden');
        }
    });
    
    window.addEventListener('drop', (e) => {
        if (driveView.classList.contains('hidden')) return;
        e.preventDefault();
        dropZone.classList.add('hidden');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileUpload({ target: { files: [files[0]] } });
        }
    });
}

// ----------------------------------------------------
// APP INITIALIZATION
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    initDragAndDrop();

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('[PWA] Service Worker registered successfully', reg))
            .catch(err => console.error('[PWA] Service Worker registration failed', err));
    }
    
    // Initialize Database
    try {
        await DB.init();
        addLog("Local IndexedDB storage initialized.", 'system');
    } catch (err) {
        console.error("IndexedDB load failed", err);
    }
    
    // Set default credentials in localStorage on load if not set
    const savedServerUser = localStorage.getItem('server_username');
    if (!savedServerUser) {
        localStorage.setItem('server_username', 'cloud-node');
        localStorage.setItem('server_password', 'aura-secure-123');
        initServerUI('cloud-node');
    } else {
        initServerUI(savedServerUser);
    }
    
    // Check server power state (always default to start server on load for easy testing)
    const serverActiveState = localStorage.getItem('server_active_state');
    if (serverActiveState !== 'false') {
        document.getElementById('server-power-switch').checked = true;
        toggleServer(true);
    }
    
    // Check client credentials
    const clientRemember = localStorage.getItem('client_remember');
    if (clientRemember === 'true') {
        const clientUser = localStorage.getItem('client_username');
        const clientPass = localStorage.getItem('client_password');
        if (clientUser && clientPass) {
            document.getElementById('connect-username').value = clientUser;
            document.getElementById('connect-password').value = clientPass;
        }
    }
    
    // Initial server refresh
    refreshServerExplorer();

    // Auto-connect client on load using pre-filled/saved credentials
    const clientUser = document.getElementById('connect-username').value;
    const clientPass = document.getElementById('connect-password').value;
    if (clientUser && clientPass) {
        setTimeout(() => {
            showToast("Auto-connecting to storage...", "info");
            document.getElementById('client-connect-form').dispatchEvent(new Event('submit'));
        }, 1000); // 1s delay gives the server node time to register on the signaling network first
    }
});
