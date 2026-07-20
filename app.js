/* AuraDrive Core Application Logic - Obsidian Minimal Edition */

// Global Variables
let db = null;
let serverPeer = null;
let clientPeer = null;
let serverConnections = []; // Server's active client connections
let clientConnection = null; // Client's connection to server
let currentPath = '/';
let serverCurrentPath = '/';
let clientFilesystem = { folders: [], files: [] };
let activeTransfers = {}; // Track active chunks transfers: fileId -> { file, chunks, totalSize, parentPath, etc }
let toastTimeout = null;

// Server initialization and auto-connection states
let isLocalServerInitializing = false;
let clientAutoConnectPending = false;
let clientConnectTimeout = null;

// File Upload chunk size (1 MB)
const CHUNK_SIZE = 1024 * 1024;

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

/// Render local files for the receiver view with folders support
async function refreshServerExplorer() {
    const listEl = document.getElementById('server-explorer-list');
    if (!listEl) return;
    
    try {
        const fs = await DB.getAllFSMetadata();
        const sizeBytes = await DB.calculateDatabaseSize();
        document.getElementById('storage-size-val').innerText = formatBytes(sizeBytes);
        document.getElementById('server-file-count').innerText = `${fs.files.length} file(s)`;

        listEl.innerHTML = '';
        
        // Render Server Breadcrumbs
        renderServerBreadcrumbs(fs);

        // Filter folders and files for current server explorer path
        const folders = fs.folders.filter(f => f.parentPath === serverCurrentPath);
        const files = fs.files.filter(f => f.parentPath === serverCurrentPath);

        if (folders.length === 0 && files.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; width: 100%; text-align: center; padding: 2rem;">
                    <i data-lucide="hard-drive"></i>
                    <p>No files or folders here.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        // Render Folders
        folders.sort((a,b) => a.name.localeCompare(b.name)).forEach(folder => {
            const fCard = document.createElement('div');
            fCard.className = 'explorer-card folder-card';
            fCard.onclick = () => navigateToServerPath(folder.path);
            
            fCard.innerHTML = `
                <div class="explorer-card-header">
                    <div class="card-icon">
                        <i data-lucide="folder"></i>
                    </div>
                    <div class="card-dropdown" onclick="event.stopPropagation()">
                        <button class="btn-icon" onclick="deleteServerItem('${folder.path}', true)" title="Delete Folder">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </div>
                <div class="explorer-card-body">
                    <div class="explorer-card-title" title="${folder.name}">${folder.name}</div>
                    <div class="explorer-card-meta">Folder</div>
                </div>
            `;
            listEl.appendChild(fCard);
        });

        // Render Files
        files.sort((a,b) => a.name.localeCompare(b.name)).forEach(file => {
            const fCard = document.createElement('div');
            fCard.className = 'explorer-card file-card';
            
            fCard.onclick = async () => {
                if (isPreviewable(file.name, file.type)) {
                    await initPreviewContext(true, file.path);
                    loadPreviewItem(previewContext.currentIndex);
                } else {
                    downloadServerFile(file.path, file.name);
                }
            };
            
            const fileIcon = getFileIconName(file.name);
            const iconClass = getFileIconClass(file.name);
            
            fCard.innerHTML = `
                <div class="explorer-card-header">
                    <div class="card-icon ${iconClass}">
                        <i data-lucide="${fileIcon}"></i>
                    </div>
                    <div class="card-dropdown" onclick="event.stopPropagation()">
                        <button class="btn-icon" onclick="downloadServerFile('${file.path}', '${file.name}')" title="Download File">
                            <i data-lucide="download"></i>
                        </button>
                        <button class="btn-icon" onclick="deleteServerItem('${file.path}', false)" title="Delete File">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </div>
                <div class="explorer-card-body">
                    <div class="explorer-card-title" title="${file.name}">${file.name}</div>
                    <div class="explorer-card-meta">${formatBytes(file.size)} • Get</div>
                </div>
            `;
            listEl.appendChild(fCard);
        });
        
        lucide.createIcons();
    } catch (err) {
        addLog(`Error loading server database: ${err.message}`, 'err');
    }
}

function navigateToServerPath(path) {
    serverCurrentPath = path;
    refreshServerExplorer();
}

function renderServerBreadcrumbs(fs) {
    const list = document.getElementById('server-breadcrumbs');
    if (!list) return;
    list.innerHTML = '';
    
    if (serverCurrentPath === '/') return;
    
    const parts = serverCurrentPath.split('/').filter(p => p !== '');
    let accumulatedPath = '';
    
    parts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.innerText = '/';
        list.appendChild(separator);
        
        const item = document.createElement('span');
        item.className = 'breadcrumb-item';
        item.innerText = part;
        
        if (index === parts.length - 1) {
            item.classList.add('active');
        } else {
            const currentAccumulated = accumulatedPath;
            item.onclick = () => navigateToServerPath(currentAccumulated);
            item.style.cursor = 'pointer';
        }
        list.appendChild(item);
    });
}

// Download file on server's physical device
async function downloadServerFile(path, filename) {
    try {
        const fileObj = await DB.getFile(path);
        if (fileObj && fileObj.data) {
            const simulatedName = path.startsWith('/') 
                ? path.slice(1).replace(/\//g, '_') 
                : path.replace(/\//g, '_');
            triggerDownload(fileObj.data, simulatedName);
            addLog(`Downloaded locally: ${simulatedName}`, 'success');
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
    document.getElementById('server-max-connections').value = localStorage.getItem('server_max_connections') || '5';
}

function closeCredentialsModal() {
    document.getElementById('credentials-modal').classList.add('hidden');
}

// Handle submit of Credentials form
function handleServerCredentialsSetup(e) {
    e.preventDefault();
    const username = document.getElementById('server-username').value.trim();
    const password = document.getElementById('server-password').value.trim();
    const maxConnections = document.getElementById('server-max-connections').value;
    
    if (!username || !password || !maxConnections) {
        showToast('Please fill all configuration fields', 'error');
        return;
    }
    
    localStorage.setItem('server_username', username);
    localStorage.setItem('server_password', password);
    localStorage.setItem('server_max_connections', maxConnections);
    
    initServerUI(username);
    
    // Restart Server if it was active to apply new Peer ID
    const isPowerOn = document.getElementById('server-power-switch').checked;
    if (isPowerOn) {
        toggleServer(false);
        toggleServer(true);
    }
    
    closeCredentialsModal();
    showToast('Credentials updated', 'success');
    addLog(`Server node configured for username: ${username} (Max connections: ${maxConnections})`, 'system');
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

        isLocalServerInitializing = true;
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
            
            isLocalServerInitializing = false;
            if (clientAutoConnectPending) {
                clientAutoConnectPending = false;
                triggerClientAutoConnect();
            }
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
                                // Check connection limit
                                const authenticatedCount = serverConnections.filter(c => c.authenticated).length;
                                const maxLimit = parseInt(localStorage.getItem('server_max_connections') || '5', 10);
                                if (authenticatedCount >= maxLimit) {
                                    addLog(`Auth rejected for client: Connection limit (${maxLimit}) reached.`, "warn");
                                    conn.send({
                                        type: 'auth-fail',
                                        message: 'Server connection limit reached.'
                                    });
                                    setTimeout(() => conn.close(), 1000);
                                    return;
                                }

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
                            
                        case 'delete-items-batch':
                            for (const item of data.items) {
                                await DB.deleteItem(item.path, item.isFolder);
                            }
                            addLog(`Batch deleted ${data.items.length} items by client`, "warn");
                            broadcastFSUpdate();
                            refreshServerExplorer();
                            break;
                            
                        case 'upload-start':
                            console.log("[DEBUG] Server received upload-start for", data.name, "size:", data.size, "totalChunks:", data.totalChunks);
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
                            console.log("[DEBUG] Server received chunk", data.chunkIndex, "for fileId:", data.fileId);
                            const transfer = activeTransfers[data.fileId];
                            if (transfer) {
                                transfer.chunks[data.chunkIndex] = data.chunkData;
                                
                                // Acknowledge receipt
                                conn.send({ type: 'upload-ack', fileId: data.fileId, chunkIndex: data.chunkIndex });
                                
                                const receivedCount = transfer.chunks.filter(c => c !== undefined).length;
                                console.log("[DEBUG] Server transfer progress:", receivedCount, "of", transfer.totalChunks);
                                
                                // Check if completed
                                if (receivedCount === transfer.totalChunks) {
                                    addLog(`Assembling complete file: ${transfer.name}`, 'system');
                                    
                                    // Merge chunks into a single Blob
                                    const fileBlob = new Blob(transfer.chunks, { type: transfer.fileType });
                                    
                                    // Save in database
                                    await DB.addFile(transfer.path, transfer.name, transfer.parentPath, transfer.fileType, transfer.size, fileBlob);
                                    addLog(`Saved file to DB: ${transfer.path}`, 'success');
                                    
                                    // Auto-download file on server device with simulated folder prefix
                                    const simulatedName = transfer.path.startsWith('/') 
                                        ? transfer.path.slice(1).replace(/\//g, '_') 
                                        : transfer.path.replace(/\//g, '_');
                                    triggerDownload(fileBlob, simulatedName);
                                    addLog(`Automatically downloaded: ${simulatedName}`, 'success');
                                    
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
            isLocalServerInitializing = false;
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
            
            if (clientAutoConnectPending) {
                clientAutoConnectPending = false;
                triggerClientAutoConnect();
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
let activeDownloadsOnServer = {}; // fileId -> { arrayBuffer, totalChunks, currentChunk, ackedChunksCount, path, name }

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
            ackedChunksCount: 0,
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
        
        // Start sending pipelined chunks
        sendPipelinedDownloadChunks(fileId);
    } catch (err) {
        addLog(`Error processing server file buffer: ${err.message}`, 'err');
        conn.send({ type: 'download-fail', path: fileObj.path, message: 'File read failure on server' });
    }
}

function sendPipelinedDownloadChunks(fileId) {
    const dl = activeDownloadsOnServer[fileId];
    if (!dl) return;
    
    const MAX_IN_FLIGHT = 4; // Max 4 chunks in flight at once
    
    while (dl && dl.currentChunk < dl.totalChunks) {
        const inFlight = dl.currentChunk - dl.ackedChunksCount;
        if (inFlight >= MAX_IN_FLIGHT) {
            // Window is full, wait for ACKs
            return;
        }
        
        sendDownloadChunk(fileId, dl.currentChunk);
        dl.currentChunk++;
    }
}

function sendDownloadChunk(fileId, chunkIndex) {
    const dl = activeDownloadsOnServer[fileId];
    if (!dl) return;
    
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, dl.arrayBuffer.byteLength);
    const chunkData = dl.arrayBuffer.slice(start, end);
    
    dl.conn.send({
        type: 'download-chunk',
        fileId: fileId,
        chunkIndex: chunkIndex,
        chunkData: chunkData
    });
}

// Handle Download Acknowledgement from Client
function handleClientDownloadAck(conn, data) {
    const dl = activeDownloadsOnServer[data.fileId];
    if (!dl) return;
    
    dl.ackedChunksCount++;
    if (dl.ackedChunksCount === dl.totalChunks) {
        addLog(`Download transmission complete for client: ${dl.name}`, 'success');
        delete activeDownloadsOnServer[data.fileId];
    } else {
        // Resume sending chunks now that window space opened up
        sendPipelinedDownloadChunks(data.fileId);
    }
}

// ----------------------------------------------------
// CLIENT SENDER LOGIC (CONNECTS TO STORAGE NODE)
// ----------------------------------------------------
function handleClientConnect(e) {
    if (e) e.preventDefault();
    
    const username = document.getElementById('connect-username').value.trim();
    const password = document.getElementById('connect-password').value.trim();
    const remember = document.getElementById('connect-remember').checked;
    
    if (!username || !password) {
        showToast("Please enter server credentials", "error");
        return;
    }
    
    if (clientConnectTimeout) {
        clearTimeout(clientConnectTimeout);
        clientConnectTimeout = null;
    }
    
    executeClientConnect(username, password, remember, 0);
}

function executeClientConnect(username, password, remember, retryCount) {
    const statusDiv = document.getElementById('client-connection-status');
    const statusText = document.getElementById('client-status-text');
    
    statusDiv.classList.remove('hidden');
    statusText.innerText = retryCount > 0 
        ? `Reconnecting (Attempt ${retryCount}/3)...` 
        : "Connecting to network...";
    
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
            if (retryCount < 3) {
                const nextRetry = retryCount + 1;
                addLog(`Server peer unavailable. Retrying in 1.5s (attempt ${nextRetry}/3)...`, "warn");
                statusText.innerText = `Retrying connection (Attempt ${nextRetry}/3)...`;
                
                setTimeout(() => {
                    executeClientConnect(username, password, remember, nextRetry);
                }, 1500);
            } else {
                showToast("Server node is offline", "error");
                statusDiv.classList.add('hidden');
                handleClientDisconnectUI();
            }
        } else {
            showToast(`Peer error: ${err.message}`, "error");
            statusDiv.classList.add('hidden');
            handleClientDisconnectUI();
        }
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
// MULTI-SELECTION STATE & TOOLBAR MANAGEMENT
// ----------------------------------------------------
function toggleItemSelection(event, path, isFolder) {
    if (event) event.stopPropagation();
    
    const index = selectedItems.findIndex(item => item.path === path);
    if (index === -1) {
        selectedItems.push({ path, isFolder });
    } else {
        selectedItems.splice(index, 1);
    }
    
    renderExplorer();
    updateSelectionToolbar();
}

function clearSelection() {
    selectedItems = [];
    renderExplorer();
    updateSelectionToolbar();
}

function updateSelectionToolbar() {
    const bulkBar = document.getElementById('bulk-actions-toolbar');
    const regularBar = document.getElementById('drive-toolbar-regular');
    const countText = document.getElementById('selected-count-text');
    
    if (!bulkBar || !regularBar || !countText) return;
    
    if (selectedItems.length > 0) {
        bulkBar.classList.remove('hidden');
        regularBar.classList.add('hidden');
        countText.innerText = `${selectedItems.length} item(s) selected`;
    } else {
        bulkBar.classList.add('hidden');
        regularBar.classList.remove('hidden');
    }
}

function deleteSelectedItems() {
    if (selectedItems.length === 0) return;
    
    if (confirm(`Are you sure you want to delete the ${selectedItems.length} selected item(s)?`)) {
        if (clientConnection && clientConnection.open) {
            clientConnection.send({
                type: 'delete-items-batch',
                items: selectedItems
            });
            showToast("Deleting selected...", "warn");
            clearSelection();
        } else {
            showToast("Connection offline", "error");
        }
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
    
    // Toggle active selection styling class on grid container
    if (selectedItems.length > 0) {
        view.classList.add('selection-active');
    } else {
        view.classList.remove('selection-active');
    }
    
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
        const isFolderSelected = selectedItems.findIndex(item => item.path === folder.path) !== -1;
        const fCard = document.createElement('div');
        fCard.className = `explorer-card folder-card${isFolderSelected ? ' selected' : ''}`;
        
        fCard.onclick = (event) => {
            if (selectedItems.length > 0) {
                toggleItemSelection(event, folder.path, true);
            } else {
                navigateToPath(folder.path);
            }
        };
        
        fCard.innerHTML = `
            <div class="explorer-card-header">
                <div class="card-checkbox-container" onclick="toggleItemSelection(event, '${folder.path}', true)">
                    <input type="checkbox" ${isFolderSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleItemSelection(event, '${folder.path}', true)">
                </div>
                <div class="card-icon" style="margin-left: 24px;">
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
        const isFileSelected = selectedItems.findIndex(item => item.path === file.path) !== -1;
        const fCard = document.createElement('div');
        fCard.className = `explorer-card file-card${isFileSelected ? ' selected' : ''}`;
        
        fCard.onclick = async (event) => {
            if (selectedItems.length > 0) {
                toggleItemSelection(event, file.path, false);
            } else {
                if (isPreviewable(file.name, file.type)) {
                    await initPreviewContext(false, file.path);
                    loadPreviewItem(previewContext.currentIndex);
                } else {
                    requestFileDownload(file.path, file.name);
                }
            }
        };
        
        const fileIcon = getFileIconName(file.name);
        const iconClass = getFileIconClass(file.name);
        
        fCard.innerHTML = `
            <div class="explorer-card-header">
                <div class="card-checkbox-container" onclick="toggleItemSelection(event, '${file.path}', false)">
                    <input type="checkbox" ${isFileSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleItemSelection(event, '${file.path}', false)">
                </div>
                <div class="card-icon ${iconClass}" style="margin-left: 24px;">
                    <i data-lucide="${fileIcon}"></i>
                </div>
                <div class="card-dropdown" onclick="event.stopPropagation()">
                    <button class="btn-icon" onclick="deleteDriveItem('${file.path}', false)" title="Delete File">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
            <div class="explorer-card-body">
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
let uploadQueue = []; // Queue for sequential file uploads
let activeUpload = null; // { fileId, file, arrayBuffer, totalChunks, currentChunk, ackedChunksCount, startTime }
let selectedItems = []; // Array of { path, isFolder } for multi-selection

function handleFileUpload(e) {
    const files = e.target.files;
    console.log("[DEBUG] handleFileUpload selected files count:", files ? files.length : 0);
    if (!files || files.length === 0) return;
    
    if (!clientConnection || !clientConnection.open) {
        showToast("Not connected to server", "error");
        return;
    }
    
    // Add all files to queue first
    for (let i = 0; i < files.length; i++) {
        uploadQueue.push(files[i]);
    }
    
    // Reset file input value so the same files can be re-selected if needed
    document.getElementById('drive-file-upload').value = '';
    
    // If not already uploading, start processing
    if (!activeUpload) {
        processNextUpload();
    } else {
        showToast(`Added ${files.length} file(s) to queue`, "info");
        const queueInfo = uploadQueue.length > 0 ? ` (${uploadQueue.length} pending)` : '';
        const filenameLabel = document.getElementById('progress-filename');
        if (filenameLabel) {
            filenameLabel.innerText = `${activeUpload.file.name}${queueInfo}`;
        }
    }
}

function processNextUpload() {
    console.log("[DEBUG] processNextUpload. Queue length:", uploadQueue.length);
    if (uploadQueue.length === 0) {
        activeUpload = null;
        hideProgressPanel();
        return;
    }
    
    const file = uploadQueue.shift();
    const filePath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
    console.log("[DEBUG] Next upload file:", file.name, "path:", filePath);
    
    // Check duplication
    const duplicate = clientFilesystem.files.find(f => f.path === filePath);
    if (duplicate) {
        if (!confirm(`Overwrite duplicate file "${file.name}"?`)) {
            // Skip this file, proceed to next
            setTimeout(processNextUpload, 50);
            return;
        }
    }
    
    const fileId = generateUUID();
    const reader = new FileReader();
    
    reader.onload = function(evt) {
        const arrayBuffer = evt.target.result;
        const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
        console.log("[DEBUG] FileReader loaded file:", file.name, "size:", arrayBuffer.byteLength, "totalChunks:", totalChunks);
        
        activeUpload = {
            fileId: fileId,
            file: file,
            arrayBuffer: arrayBuffer,
            totalChunks: totalChunks,
            currentChunk: 0,
            ackedChunksCount: 0,
            startTime: Date.now()
        };
        
        const queueInfo = uploadQueue.length > 0 ? ` (${uploadQueue.length} pending)` : '';
        showProgressPanel(`${file.name}${queueInfo}`);
        updateProgressUI(0, "Initiating...");
        
        console.log("[DEBUG] Sending upload-start to server");
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

function sendPipelinedChunks() {
    if (!activeUpload) return;
    
    const MAX_IN_FLIGHT = 4; // Max 4 chunks in flight at once (4 MB window)
    console.log("[DEBUG] sendPipelinedChunks active. currentChunk:", activeUpload.currentChunk, "ackedChunksCount:", activeUpload.ackedChunksCount);
    
    while (activeUpload && activeUpload.currentChunk < activeUpload.totalChunks) {
        const inFlight = activeUpload.currentChunk - activeUpload.ackedChunksCount;
        if (inFlight >= MAX_IN_FLIGHT) {
            console.log("[DEBUG] Window full. inFlight:", inFlight, "MAX:", MAX_IN_FLIGHT);
            return;
        }
        
        sendUploadChunk(activeUpload.currentChunk);
        activeUpload.currentChunk++;
    }
}

function sendUploadChunk(chunkIndex) {
    const up = activeUpload;
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, up.arrayBuffer.byteLength);
    const chunkData = up.arrayBuffer.slice(start, end);
    console.log("[DEBUG] sendUploadChunk", chunkIndex, "slice range:", start, "to", end);
    
    const pct = Math.round((start / up.arrayBuffer.byteLength) * 100);
    const elapsedSeconds = (Date.now() - up.startTime) / 1000;
    const speed = elapsedSeconds > 0 ? (start / elapsedSeconds) : 0;
    const queueInfo = uploadQueue.length > 0 ? ` (${uploadQueue.length} pending)` : '';
    
    updateProgressUI(
        pct, 
        `${pct}% • ${formatBytes(speed)}/s${queueInfo}`
    );
    
    clientConnection.send({
        type: 'upload-chunk',
        fileId: up.fileId,
        chunkIndex: chunkIndex,
        chunkData: chunkData
    });
}

function handleServerUploadAck(data) {
    console.log("[DEBUG] Client received upload-ack. chunkIndex:", data.chunkIndex, "fileId:", data.fileId);
    if (!activeUpload || activeUpload.fileId !== data.fileId) {
        console.log("[DEBUG] Ack ignored. activeUpload is", activeUpload ? "for fileId " + activeUpload.fileId : "null");
        return;
    }
    
    if (data.chunkIndex === -1) {
        // Handshake ACK received, start pipelined sending!
        activeUpload.currentChunk = 0;
        sendPipelinedChunks();
    } else {
        // Chunk ACK received
        activeUpload.ackedChunksCount++;
        
        const bytesStored = activeUpload.ackedChunksCount * CHUNK_SIZE;
        const totalSize = activeUpload.arrayBuffer.byteLength;
        const pct = Math.min(100, Math.round((bytesStored / totalSize) * 100));
        const elapsedSeconds = (Date.now() - activeUpload.startTime) / 1000;
        const speed = elapsedSeconds > 0 ? (bytesStored / elapsedSeconds) : 0;
        const queueInfo = uploadQueue.length > 0 ? ` (${uploadQueue.length} pending)` : '';
        
        updateProgressUI(
            pct, 
            `${pct}% • ${formatBytes(speed)}/s${queueInfo}`
        );
        
        if (activeUpload.ackedChunksCount === activeUpload.totalChunks) {
            showToast(`Uploaded: ${activeUpload.file.name}`, "success");
            activeUpload = null;
            
            // Proceed to the next file in the queue
            processNextUpload();
        } else {
            // Resume pipelined sending now that window space opened up
            sendPipelinedChunks();
        }
    }
}

function cancelUpload() {
    const wasUploading = !!activeUpload;
    if (activeUpload) {
        if (clientConnection && clientConnection.open) {
            clientConnection.send({
                type: 'upload-cancel',
                fileId: activeUpload.fileId
            });
        }
        activeUpload = null;
    }
    uploadQueue = []; // Clear the queue!
    if (wasUploading) {
        showToast("Upload and queue cancelled", "warn");
    }
    hideProgressPanel();
}

// ----------------------------------------------------
// CLIENT FILE DOWNLOAD WITH CHUNKING
// ----------------------------------------------------
let activeDownload = null; // { isPreview, fileId, name, size, fileType, totalChunks, chunks: [], startTime }
let previewBlobUrl = null; // Track current preview object URL
let previewContext = {
    isServer: false,
    items: [], // Sibling files in the current path
    currentIndex: -1
};

function isPreviewable(name, type) {
    const t = type ? type.toLowerCase() : '';
    if (t.startsWith('image/') || t.startsWith('video/')) return true;
    
    const ext = name.split('.').pop().toLowerCase();
    const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico'];
    const videoExtensions = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'];
    
    return imageExtensions.includes(ext) || videoExtensions.includes(ext);
}

function getMimeFromExtension(name) {
    const ext = name.split('.').pop().toLowerCase();
    const mimeMap = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'webp': 'image/webp',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'ogg': 'video/ogg'
    };
    return mimeMap[ext] || 'application/octet-stream';
}

async function initPreviewContext(isServer, currentFilePath) {
    previewContext.isServer = isServer;
    
    if (isServer) {
        try {
            const fs = await DB.getAllFSMetadata();
            const files = fs.files
                .filter(f => f.parentPath === serverCurrentPath && isPreviewable(f.name, f.type))
                .sort((a, b) => a.name.localeCompare(b.name));
            previewContext.items = files.map(f => ({ path: f.path, name: f.name, type: f.type }));
        } catch (err) {
            console.error("Failed to load server files for preview context:", err);
            previewContext.items = [];
        }
    } else {
        const files = clientFilesystem.files
            .filter(f => f.parentPath === currentPath && isPreviewable(f.name, f.type))
            .sort((a, b) => a.name.localeCompare(b.name));
        previewContext.items = files.map(f => ({ path: f.path, name: f.name, type: f.type }));
    }
    
    previewContext.currentIndex = previewContext.items.findIndex(item => item.path === currentFilePath);
    console.log("[DEBUG] initPreviewContext. Items count:", previewContext.items.length, "Current index:", previewContext.currentIndex);
}

async function loadPreviewItem(index) {
    console.log("[DEBUG] loadPreviewItem at index:", index, "Total items:", previewContext.items.length);
    if (index < 0 || index >= previewContext.items.length) return;
    
    previewContext.currentIndex = index;
    const item = previewContext.items[index];
    console.log("[DEBUG] Loading preview item:", item.name);
    
    // Revoke previous URL to save browser memory
    if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
    }
    
    // Cancel any active WebRTC stream download
    if (activeDownload) {
        activeDownload = null;
    }
    
    // Clear preview and set loading state
    openPreviewModal(item.name, item.type || getMimeFromExtension(item.name), null, null);
    
    // Toggle chevrons depending on index boundaries
    updatePreviewChevrons();
    
    if (previewContext.isServer) {
        try {
            const fileObj = await DB.getFile(item.path);
            if (!fileObj || !fileObj.data) {
                showToast("File data not found on server", "error");
                return;
            }
            previewBlobUrl = URL.createObjectURL(fileObj.data);
            openPreviewModal(item.name, item.type || fileObj.type || getMimeFromExtension(item.name), previewBlobUrl, () => {
                triggerDownload(fileObj.data, item.name);
            });
        } catch (err) {
            showToast(`Failed to open preview: ${err.message}`, "error");
        }
    } else {
        requestFilePreview(item.path, item.name, item.type || getMimeFromExtension(item.name));
    }
}

function updatePreviewChevrons() {
    const prevBtn = document.getElementById('preview-prev-btn');
    const nextBtn = document.getElementById('preview-next-btn');
    
    if (!prevBtn || !nextBtn) return;
    
    const idx = previewContext.currentIndex;
    const len = previewContext.items.length;
    
    if (idx > 0) {
        prevBtn.classList.remove('hidden');
    } else {
        prevBtn.classList.add('hidden');
    }
    
    if (idx < len - 1 && len > 0) {
        nextBtn.classList.remove('hidden');
    } else {
        nextBtn.classList.add('hidden');
    }
}

function navigatePreview(direction) {
    const nextIndex = previewContext.currentIndex + direction;
    console.log("[DEBUG] navigatePreview. Direction:", direction, "Current index:", previewContext.currentIndex, "Target nextIndex:", nextIndex);
    if (nextIndex >= 0 && nextIndex < previewContext.items.length) {
        loadPreviewItem(nextIndex);
    }
}

// Bind Global Keydown Listener for Arrow Navigation
window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('preview-modal');
    if (modal && !modal.classList.contains('hidden')) {
        if (e.key === 'ArrowLeft') {
            navigatePreview(-1);
        } else if (e.key === 'ArrowRight') {
            navigatePreview(1);
        } else if (e.key === 'Escape') {
            closePreviewModal();
        }
    }
});

function openPreviewModal(name, fileType, blobUrl, downloadCallback) {
    const modal = document.getElementById('preview-modal');
    const title = document.getElementById('preview-title');
    const loader = document.getElementById('preview-loader');
    const container = document.getElementById('preview-content-container');
    const downloadBtn = document.getElementById('preview-download-btn');
    
    if (!modal) return;
    
    title.innerText = name;
    modal.classList.remove('hidden');
    
    if (blobUrl) {
        if (loader) loader.classList.add('hidden');
        renderPreviewMedia(name, fileType, blobUrl);
    } else {
        if (loader) loader.classList.remove('hidden');
        if (container) container.innerHTML = '';
        if (downloadBtn) downloadBtn.style.display = 'none';
    }
    
    if (downloadCallback) {
        downloadBtn.onclick = () => {
            downloadCallback();
        };
    }
}

function renderPreviewMedia(name, fileType, blobUrl) {
    const loader = document.getElementById('preview-loader');
    const container = document.getElementById('preview-content-container');
    const downloadBtn = document.getElementById('preview-download-btn');
    
    if (loader) loader.classList.add('hidden');
    if (downloadBtn) downloadBtn.style.display = 'inline-flex';
    
    if (!container) return;
    container.innerHTML = '';
    
    const type = fileType ? fileType.toLowerCase() : '';
    if (type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = blobUrl;
        img.className = 'preview-media-image';
        img.alt = name;
        container.appendChild(img);
    } else if (type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = blobUrl;
        video.className = 'preview-media-video';
        video.controls = true;
        video.autoplay = true;
        container.appendChild(video);
    } else {
        container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.9rem;">Preview not supported for this file type.</span>`;
    }
}

function closePreviewModal() {
    const modal = document.getElementById('preview-modal');
    if (modal) modal.classList.add('hidden');
    
    const container = document.getElementById('preview-content-container');
    if (container) container.innerHTML = '';
    
    if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
    }
    
    // Stop any active preview stream if closed early
    if (activeDownload && activeDownload.isPreview) {
        activeDownload = null;
    }
}

function requestFileDownload(path, name) {
    if (!clientConnection || !clientConnection.open) {
        showToast("Not connected to server", "error");
        return;
    }
    
    showToast("Requesting file...", "info");
    
    activeDownload = {
        isPreview: false,
        path: path,
        name: name,
        chunks: [],
        startTime: Date.now()
    };
    
    clientConnection.send({
        type: 'download-req',
        path: path
    });
}

function requestFilePreview(path, name, fileType) {
    if (!clientConnection || !clientConnection.open) {
        showToast("Not connected to server", "error");
        return;
    }
    
    openPreviewModal(name, fileType, null, () => {
        if (previewBlobUrl) {
            const a = document.createElement('a');
            a.href = previewBlobUrl;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    });
    
    activeDownload = {
        isPreview: true,
        path: path,
        name: name,
        fileType: fileType,
        chunks: [],
        startTime: Date.now()
    };
    
    clientConnection.send({
        type: 'download-req',
        path: path
    });
}

function initClientDownload(data) {
    const isPreview = activeDownload && activeDownload.isPreview;
    
    activeDownload = {
        isPreview: isPreview,
        fileId: data.fileId,
        name: data.name,
        size: data.size,
        fileType: data.fileType,
        totalChunks: data.totalChunks,
        chunks: [],
        startTime: Date.now()
    };
    
    if (isPreview) {
        const container = document.getElementById('preview-content-container');
        if (container) {
            container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.9rem;">Streaming preview... (0%)</span>`;
        }
    } else {
        showProgressPanel(`Downloading: ${data.name}`);
        updateProgressUI(0, "Downloading...");
    }
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
    
    if (dl.isPreview) {
        const container = document.getElementById('preview-content-container');
        if (container) {
            container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.9rem;">Streaming preview... (${pct}%) • ${formatBytes(speed)}/s</span>`;
        }
    } else {
        updateProgressUI(
            pct,
            `${pct}% • ${formatBytes(speed)}/s`
        );
    }
    
    clientConnection.send({
        type: 'download-ack',
        fileId: dl.fileId,
        chunkIndex: data.chunkIndex
    });
    
    if (chunksReceived === dl.totalChunks) {
        if (dl.isPreview) {
            const fileBlob = new Blob(dl.chunks, { type: dl.fileType });
            previewBlobUrl = URL.createObjectURL(fileBlob);
            renderPreviewMedia(dl.name, dl.fileType, previewBlobUrl);
        } else {
            showToast("Download completed!", "success");
            hideProgressPanel();
            
            const fileBlob = new Blob(dl.chunks, { type: dl.fileType });
            triggerDownload(fileBlob, dl.name);
        }
        
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
            handleFileUpload({ target: { files: files } });
        }
    });
}

// ----------------------------------------------------
// APP INITIALIZATION
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    initDragAndDrop();
    initTouchGestures();

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
        localStorage.setItem('server_max_connections', '5');
        initServerUI('cloud-node');
    } else {
        initServerUI(savedServerUser);
    }
    if (!localStorage.getItem('server_max_connections')) {
        localStorage.setItem('server_max_connections', '5');
    }
    
    // Check server power state (always default to start server on load for easy testing)
    const serverActiveState = localStorage.getItem('server_active_state');
    if (serverActiveState !== 'false') {
        document.getElementById('server-power-switch').checked = true;
        toggleServer(true);
    }
    
    // Check client credentials
    const clientRemember = localStorage.getItem('client_remember');
    let willAutoConnect = false;
    if (clientRemember === 'true') {
        const clientUser = localStorage.getItem('client_username');
        const clientPass = localStorage.getItem('client_password');
        if (clientUser && clientPass) {
            document.getElementById('connect-username').value = clientUser;
            document.getElementById('connect-password').value = clientPass;
            willAutoConnect = true;
        }
    }
    
    if (willAutoConnect) {
        document.getElementById('client-auth-view').classList.add('hidden');
        document.getElementById('client-connection-status').classList.remove('hidden');
        document.getElementById('client-status-text').innerText = "Auto-connecting to storage...";
    }
    
    // Initial server refresh
    refreshServerExplorer();

    // Auto-connect client on load using pre-filled/saved credentials
    const clientUser = document.getElementById('connect-username').value;
    const clientPass = document.getElementById('connect-password').value;
    if (clientUser && clientPass) {
        if (isLocalServerInitializing) {
            clientAutoConnectPending = true;
            addLog("Deferring client connection until local server peer is online...", "system");
        } else {
            clientConnectTimeout = setTimeout(() => {
                triggerClientAutoConnect();
            }, 500); // Small delay to let initial callbacks register
        }
    }
});

function triggerClientAutoConnect() {
    showToast("Auto-connecting to storage...", "info");
    const connectForm = document.getElementById('client-connect-form');
    if (connectForm) {
        connectForm.dispatchEvent(new Event('submit'));
    }
}

function initTouchGestures() {
    const modal = document.getElementById('preview-modal');
    if (!modal) return;
    
    let touchStartX = 0;
    let touchEndX = 0;
    let touchStartY = 0;
    let touchEndY = 0;
    
    modal.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
        console.log("[DEBUG] Touchstart on preview modal:", touchStartX, touchStartY);
    }, { passive: true });
    
    modal.addEventListener('touchmove', (e) => {
        // Prevent default browser viewport scrolling/zooming inside gallery modal
        e.preventDefault();
    }, { passive: false });
    
    modal.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        
        const swipeThresholdX = 40; // minimum pixels horizontally for high sensitivity
        const swipeThresholdY = 80; // minimum pixels vertically for pull-down close
        const diffX = touchEndX - touchStartX;
        const diffY = touchEndY - touchStartY;
        
        console.log("[DEBUG] Touchend on preview modal. diffX:", diffX, "diffY:", diffY);
        
        // Check horizontal swipe
        if (Math.abs(diffX) > swipeThresholdX && Math.abs(diffX) > Math.abs(diffY)) {
            if (diffX > 0) {
                console.log("[DEBUG] Swipe Right detected -> navigate(-1)");
                navigatePreview(-1); // Swipe right -> Prev
            } else {
                console.log("[DEBUG] Swipe Left detected -> navigate(1)");
                navigatePreview(1); // Swipe left -> Next
            }
        } 
        // Check vertical swipe (e.g. pull down to close!)
        else if (diffY > swipeThresholdY && Math.abs(diffY) > Math.abs(diffX)) {
            console.log("[DEBUG] Pull Down Swipe detected -> closing modal");
            closePreviewModal();
        }
    }, { passive: true });
}
