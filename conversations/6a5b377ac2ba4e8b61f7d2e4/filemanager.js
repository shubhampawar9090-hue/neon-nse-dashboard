        // HTML escape function to prevent XSS when rendering file names
        function escapeHtml(str) {
            if (typeof str !== 'string') return str;
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        // Debug mode - enable console logging only when ?debug=1 is in URL
        const urlParams = new URLSearchParams(window.location.search);
        const DEBUG_MODE = urlParams.get('debug') === '1';

        // Override console.log to check debug mode
        const originalConsoleLog = console.log;
        console.log = function(...args) {
            if (DEBUG_MODE) {
                originalConsoleLog.apply(console, args);
            }
        };

        // Keep console.error and console.warn always active for important messages

        // Security: Block developer tools while preserving file manager functionality
        // Allow all developer tools when debug=1 is in URL
        document.addEventListener('keydown', function(e) {
            // Skip all blocking when in debug mode
            if (DEBUG_MODE) {
                return true; // Allow all shortcuts in debug mode
            }

            // Block Ctrl+U (View Source)
            if (e.ctrlKey && e.keyCode === 85) {
                e.preventDefault();
                return false;
            }
            // Block F12 (Developer Tools)
            if (e.keyCode === 123) {
                e.preventDefault();
                return false;
            }
            // Block Ctrl+Shift+I (Developer Tools)
            if (e.ctrlKey && e.shiftKey && e.keyCode === 73) {
                e.preventDefault();
                return false;
            }
            // Block Ctrl+Shift+J (Console)
            if (e.ctrlKey && e.shiftKey && e.keyCode === 74) {
                e.preventDefault();
                return false;
            }
            // Block Ctrl+Shift+C (Inspect Element)
            if (e.ctrlKey && e.shiftKey && e.keyCode === 67) {
                e.preventDefault();
                return false;
            }

            // Escape key to close modals
            if (e.key === 'Escape') {
                // Check which modal is open and close it
                const editorModal = document.getElementById('editorModal');
                const uploadModal = document.getElementById('uploadModal');
                const createDirModal = document.getElementById('createDirModal');
                const createFileModal = document.getElementById('createFileModal');
                const renameModal = document.getElementById('renameModal');
                const moveModal = document.getElementById('moveModal');
                const copyModal = document.getElementById('copyModal');

                if (editorModal && editorModal.classList.contains('show')) {
                    // Check for unsaved changes before closing editor
                    if (hasUnsavedChanges()) {
                        if (confirm('You have unsaved changes. Are you sure you want to close without saving?')) {
                            closeModal('editorModal');
                        }
                    } else {
                        closeModal('editorModal');
                    }
                    e.preventDefault();
                } else if (uploadModal && uploadModal.classList.contains('show')) {
                    closeModal('uploadModal');
                    e.preventDefault();
                } else if (createDirModal && createDirModal.classList.contains('show')) {
                    closeModal('createDirModal');
                    e.preventDefault();
                } else if (createFileModal && createFileModal.classList.contains('show')) {
                    closeModal('createFileModal');
                    e.preventDefault();
                } else if (renameModal && renameModal.classList.contains('show')) {
                    closeModal('renameModal');
                    e.preventDefault();
                } else if (moveModal && moveModal.classList.contains('show')) {
                    closeModal('moveModal');
                    e.preventDefault();
                } else if (copyModal && copyModal.classList.contains('show')) {
                    closeModal('copyModal');
                    e.preventDefault();
                }
            }
        });

        // Selective right-click blocking - allow on interactive elements
        document.addEventListener('contextmenu', function(e) {
            // Allow all right-clicks when in debug mode
            if (DEBUG_MODE) {
                return true; // Allow all right-clicks in debug mode
            }

            // Allow right-click on file manager elements and form inputs
            const allowedElements = 'input, textarea, select, .file-item, .directory-item, .file-grid-item, .file-list-item, .file-grid, .file-list-table, #fileList, #codeEditor, .CodeMirror';

            if (!e.target.closest(allowedElements)) {
                e.preventDefault();
                return false;
            }
        });

        let currentDir = '/';
        let selectedItems = [];
        let viewMode = 'list';
        let allFiles = [];
        let sortColumn = 'name'; // Current sort column: 'name', 'extension', 'size', 'modified'
        let sortDirection = 'asc'; // Sort direction: 'asc' or 'desc'

        // Check for home directory from session (set during login) or URL parameter
        function initializeFromURL() {
            // First check if session has a home directory (passed from PHP via window.SESSION_HOME)
            const sessionHome = window.SESSION_HOME || null;
            if (sessionHome) {
                currentDir = sessionHome;
                return;
            }

            // Fall back to URL parameter for backward compatibility
            const urlParams = new URLSearchParams(window.location.search);
            const homeDir = urlParams.get('home');
            if (homeDir) {
                currentDir = homeDir;
            }
        }

        // Rate limiting for concurrent requests
        class RequestLimiter {
            constructor(maxConcurrent = 3) {
                this.maxConcurrent = maxConcurrent;
                this.activeRequests = 0;
                this.queue = [];
            }

            async execute(requestFunction) {
                return new Promise((resolve, reject) => {
                    this.queue.push({ requestFunction, resolve, reject });
                    this.processQueue();
                });
            }

            async processQueue() {
                if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
                    return;
                }

                const { requestFunction, resolve, reject } = this.queue.shift();
                this.activeRequests++;

                try {
                    const result = await requestFunction();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.activeRequests--;
                    this.processQueue();
                }
            }
        }

        // Create global rate limiter instance
        const requestLimiter = new RequestLimiter(3);

        // Context Menu Variables and Functions
        let contextMenuTarget = null;

        function showContextMenu(e, itemName, itemType, fullPath = null) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();

            const contextMenu = document.getElementById('contextMenu');

            // Get position from either mouse event or touch event
            const pageX = e.pageX || (e.touches && e.touches[0] ? e.touches[0].pageX : 0);
            const pageY = e.pageY || (e.touches && e.touches[0] ? e.touches[0].pageY : 0);

            // Check if the right-clicked item is part of the selection
            const isPartOfSelection = itemName && selectedItems.some(item => item.name === itemName);
            const useSelection = isPartOfSelection && selectedItems.length > 0;

            // Determine target directory for new file/folder/upload operations
            let targetDir = currentDir;

            if (itemType === 'dir' && itemName && itemName !== '..') {
                // Right-clicking on a folder - use that folder's path
                targetDir = fullPath || (currentDir === '/' ? '/' + itemName : currentDir + '/' + itemName);
            } else if (itemType === 'file' && fullPath) {
                // Right-clicking on a file in expanded folder - use the file's parent directory
                targetDir = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/';
            }

            contextMenuTarget = {
                name: itemName,
                type: itemType,
                fullPath: fullPath,
                targetDir: targetDir,
                useSelection: useSelection,
                selectedCount: useSelection ? selectedItems.length : 1
            };

            // Get all menu items
            const editItem = contextMenu.querySelector('[data-action="edit"]');
            const downloadItem = contextMenu.querySelector('[data-action="download"]');
            const renameItem = contextMenu.querySelector('[data-action="rename"]');
            const copyItem = contextMenu.querySelector('[data-action="copy"]');
            const moveItem = contextMenu.querySelector('[data-action="move"]');
            const deleteItem = contextMenu.querySelector('[data-action="delete"]');
            const newFolderItem = contextMenu.querySelector('[data-action="newfolder"]');
            const newFileItem = contextMenu.querySelector('[data-action="newfile"]');
            const uploadItem = contextMenu.querySelector('[data-action="upload"]');

            // Show/hide items based on context
            // New folder, new file, and upload are always visible
            newFolderItem.style.display = 'flex';
            newFileItem.style.display = 'flex';
            uploadItem.style.display = 'flex';

            if (itemName) {
                // Right-clicked on a file or folder
                const isFile = itemType === 'file';
                const multipleSelected = useSelection && selectedItems.length > 1;

                editItem.style.display = (isFile && !multipleSelected) ? 'flex' : 'none';
                downloadItem.style.display = 'flex';
                renameItem.style.display = multipleSelected ? 'none' : 'flex';
                copyItem.style.display = 'flex';
                moveItem.style.display = 'flex';
                deleteItem.style.display = 'flex';

                // Update text for multiple selections
                if (multipleSelected) {
                    downloadItem.innerHTML = `<i class="fas fa-download"></i> Download Selected (${selectedItems.length})`;
                    copyItem.innerHTML = `<i class="fas fa-copy"></i> Copy Selected (${selectedItems.length})`;
                    moveItem.innerHTML = `<i class="fas fa-arrows-alt"></i> Move Selected (${selectedItems.length})`;
                    deleteItem.innerHTML = `<i class="fas fa-trash"></i> Delete Selected (${selectedItems.length})`;
                } else {
                    downloadItem.innerHTML = '<i class="fas fa-download"></i> Download';
                    copyItem.innerHTML = '<i class="fas fa-copy"></i> Copy';
                    moveItem.innerHTML = '<i class="fas fa-arrows-alt"></i> Move';
                    deleteItem.innerHTML = '<i class="fas fa-trash"></i> Delete';
                }
            } else {
                // Right-clicked on empty space
                editItem.style.display = 'none';
                downloadItem.style.display = 'none';
                renameItem.style.display = 'none';
                copyItem.style.display = 'none';
                moveItem.style.display = 'none';
                deleteItem.style.display = 'none';
            }

            // Position the menu
            contextMenu.style.display = 'block';
            contextMenu.style.left = pageX + 'px';
            contextMenu.style.top = pageY + 'px';

            // Adjust position if menu goes off screen
            const menuRect = contextMenu.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;

            if (menuRect.right > windowWidth) {
                contextMenu.style.left = (pageX - menuRect.width) + 'px';
            }
            if (menuRect.bottom > windowHeight) {
                contextMenu.style.top = (pageY - menuRect.height) + 'px';
            }
        }

        function hideContextMenu() {
            const contextMenu = document.getElementById('contextMenu');
            contextMenu.style.display = 'none';
            contextMenuTarget = null;
        }

        // Handle context menu item clicks
        document.addEventListener('DOMContentLoaded', function() {
            const contextMenu = document.getElementById('contextMenu');
            const fileList = document.getElementById('fileList');

            // Add right-click handler to file list for empty space
            if (fileList) {
                fileList.addEventListener('contextmenu', function(e) {
                    // Check if clicked directly on the file list container (empty space)
                    if (e.target === fileList || e.target.classList.contains('file-grid') || e.target.classList.contains('file-list-table')) {
                        showContextMenu(e, null, null);
                    }
                });
            }

            contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const action = this.getAttribute('data-action');

                    // Handle actions that work regardless of context
                    // Use targetDir from contextMenuTarget if available
                    const targetDir = contextMenuTarget ? contextMenuTarget.targetDir : currentDir;

                    if (action === 'newfolder') {
                        showCreateDirModal(targetDir);
                        hideContextMenu();
                        return;
                    } else if (action === 'newfile') {
                        showCreateFileModal(targetDir);
                        hideContextMenu();
                        return;
                    } else if (action === 'upload') {
                        showUploadModal(targetDir);
                        hideContextMenu();
                        return;
                    }

                    if (contextMenuTarget) {
                        const { name, type, fullPath, useSelection, selectedCount } = contextMenuTarget;

                        switch(action) {
                            case 'edit':
                                if (type === 'file' && (!useSelection || selectedCount === 1)) editFile(name, fullPath);
                                break;
                            case 'download':
                                if (useSelection) {
                                    downloadSelected();
                                } else if (type === 'file') {
                                    downloadFile(name, e, fullPath);
                                } else {
                                    downloadFolder(name, e, fullPath);
                                }
                                break;
                            case 'rename':
                                if (!useSelection) renameItem(name, e, fullPath);
                                break;
                            case 'copy':
                                if (useSelection) {
                                    copySelected();
                                } else {
                                    copyItem(name, type, e, fullPath);
                                }
                                break;
                            case 'move':
                                if (useSelection) {
                                    moveSelected();
                                } else {
                                    moveItem(name, type, e, fullPath);
                                }
                                break;
                            case 'delete':
                                if (useSelection) {
                                    deleteSelected();
                                } else {
                                    deleteItem(name, type, e, fullPath);
                                }
                                break;
                        }
                    }

                    hideContextMenu();
                });
            });

            // Hide context menu when clicking outside
            document.addEventListener('click', hideContextMenu);
        });

        // Cookie utility functions
        function setCookie(name, value, days = 365) {
            const expires = new Date();
            expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
            document.cookie = name + '=' + value + ';expires=' + expires.toUTCString() + ';path=/;SameSite=Lax';
        }

        function getCookie(name) {
            const nameEQ = name + "=";
            const ca = document.cookie.split(';');
            for(let i = 0; i < ca.length; i++) {
                let c = ca[i];
                while (c.charAt(0) === ' ') c = c.substring(1, c.length);
                if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
            }
            return null;
        }

        function deleteCookie(name) {
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            // Initialize from URL parameters first
            initializeFromURL();

            // Load user preferences from cookies
            loadUserPreferences();

            refreshList();

            // Initialize drag selection
            initDragSelection();

            // Modal backdrop click handlers - close modal when clicking outside content
            document.querySelectorAll('.modal').forEach(modal => {
                modal.addEventListener('click', function(e) {
                    // Only close if clicked directly on the backdrop (not on modal content)
                    if (e.target === this) {
                        const modalId = this.id;
                        if (modalId === 'editorModal') {
                            // Use unsaved changes check for editor
                            closeEditorWithCheck();
                        } else {
                            closeModal(modalId);
                        }
                    }
                });
            });

            // Auto-upload folder when selected
            document.getElementById('folderInput').addEventListener('change', function() {
                if (this.files.length > 0 && currentUploadType === 'folder') {
                    // Automatically start upload when folder is selected
                    uploadFolder();
                }
            });

            // Keyboard support for sidebar
            document.addEventListener('keydown', function(event) {
                if (event.key === 'Escape') {
                    closeSidebar();
                    hideMobileActions();
                }
            });
        });

        // Load user preferences from cookies
        function loadUserPreferences() {
            // Load theme preference (default to dark if no preference set)
            // Note: Theme is already set server-side, but this ensures consistency
            const savedTheme = getCookie('filemanager_theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            document.body.setAttribute('data-theme', savedTheme);

            // Load view mode preference (default to list if no preference set)
            const savedViewMode = getCookie('filemanager_viewmode');
            if (savedViewMode && (savedViewMode === 'grid' || savedViewMode === 'list')) {
                viewMode = savedViewMode;
            }
            // Update UI buttons to reflect current view mode
            document.getElementById('gridViewBtn').classList.toggle('active', viewMode === 'grid');
            document.getElementById('listViewBtn').classList.toggle('active', viewMode === 'list');

            
            // Show a brief confirmation that preferences were loaded
            if (savedTheme || savedViewMode) {
                showPreferenceMessage('Preferences loaded from cookies');
            }
        }

        // Save all current preferences
        function saveUserPreferences() {
            const currentTheme = document.body.getAttribute('data-theme') || 'dark';
            setCookie('filemanager_theme', currentTheme);
            setCookie('filemanager_viewmode', viewMode);
        }

        // Reset all preferences to defaults
        function resetUserPreferences() {
            deleteCookie('filemanager_theme');
            deleteCookie('filemanager_viewmode');

            // Reset to defaults (dark mode and list view)
            document.documentElement.setAttribute('data-theme', 'dark');
            document.body.setAttribute('data-theme', 'dark');
            setView('list');

            showPreferenceMessage('Settings reset to defaults');
        }

        // Show preference message
        function showPreferenceMessage(message) {
            // Use the status area to show preference messages briefly
            const originalStatus = document.getElementById('itemCount').textContent;
            document.getElementById('itemCount').textContent = message;
            document.getElementById('itemCount').style.color = 'var(--accent-color)';
            
            setTimeout(() => {
                updateStatus(); // Restore normal status
                document.getElementById('itemCount').style.color = '';
            }, 2000);
        }

        // Refresh file list
        async function refreshList() {
            showLoader();

            // Save currently expanded folders
            const foldersToReExpand = [];
            expandedFolders.forEach((isExpanded, folderPath) => {
                if (isExpanded) {
                    foldersToReExpand.push(folderPath);
                }
            });

            try {
                const response = await fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=list&dir=' + encodeURIComponent(currentDir)
                });

                const data = await response.json();
                hideLoader();

                if (data.success) {
                    allFiles = data.items || [];
                    displayFiles(allFiles);
                    updateBreadcrumb();
                    updateStatus();

                    // Re-expand previously expanded folders
                    if (foldersToReExpand.length > 0) {
                        await restoreExpandedFolders(foldersToReExpand);
                    }

                    // Focus file list for keyboard navigation
                    setTimeout(() => {
                        const fileList = document.getElementById('fileList');
                        if (fileList && !document.querySelector('.modal.show')) {
                            fileList.focus();
                            // Select first item if nothing focused
                            if (focusedFileIndex < 0) {
                                const items = getFileItems();
                                if (items.length > 0) {
                                    focusFileItem(0);
                                }
                            }
                        }
                    }, 100);
                }
            } catch (error) {
                hideLoader();
                console.error('Error:', error);
            }
        }

        // Restore expanded folder state after refresh
        async function restoreExpandedFolders(folderPaths) {

            // Sort by depth (shallowest first) to expand in correct order
            const sorted = folderPaths.sort((a, b) => {
                const depthA = a.split('/').filter(p => p).length;
                const depthB = b.split('/').filter(p => p).length;
                return depthA - depthB;
            });

            for (const folderPath of sorted) {
                // Find the folder element by matching fullPath in dataset
                const allFolders = document.querySelectorAll('.file-list-item[data-type="dir"]');
                let folderElement = null;

                for (const folder of allFolders) {
                    if (folder.dataset.fullPath === folderPath) {
                        folderElement = folder;
                        break;
                    }
                }

                if (folderElement) {
                    const expandIcon = folderElement.querySelector('.folder-expand-icon');
                    const folderName = folderElement.dataset.name;

                    if (expandIcon && !expandIcon.classList.contains('expanded')) {
                        // Small delay to ensure DOM is ready
                        await new Promise(resolve => setTimeout(resolve, 100));
                        await loadFolderContents(folderElement, folderName, folderPath);
                        expandIcon.classList.add('expanded');
                        expandedFolders.set(folderPath, true);
                    }
                }
            }
        }

        // Helper function to get file extension
        function getFileExtension(filename) {
            if (!filename) return '';

            // Hidden files (files starting with .) have no extension
            // Examples: .htaccess, .gitignore, .env.local, .htpasswd.123 all return empty
            if (filename.startsWith('.')) {
                return '';
            }

            // Regular files - check if there's a dot
            const lastDotIndex = filename.lastIndexOf('.');
            if (lastDotIndex === -1 || lastDotIndex === 0) return '';
            return filename.substring(lastDotIndex + 1).toLowerCase();
        }

        // Sorting functions
        function sortFiles(items) {
            // Create a copy to avoid mutating the original array
            const sortedItems = [...items];

            sortedItems.sort((a, b) => {
                // Always put directories first, then files
                if (a.type !== b.type) {
                    return a.type === 'dir' ? -1 : 1;
                }

                // Then sort by the selected column
                let compareResult = 0;

                if (sortColumn === 'name') {
                    compareResult = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                } else if (sortColumn === 'extension') {
                    const extA = getFileExtension(a.name);
                    const extB = getFileExtension(b.name);
                    compareResult = extA.localeCompare(extB);
                    // If extensions are the same, sort by name
                    if (compareResult === 0) {
                        compareResult = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                    }
                } else if (sortColumn === 'size') {
                    compareResult = (a.size || 0) - (b.size || 0);
                } else if (sortColumn === 'modified') {
                    // Compare dates - convert to timestamps
                    const dateA = new Date(a.modified || a.date || 0).getTime();
                    const dateB = new Date(b.modified || b.date || 0).getTime();
                    compareResult = dateA - dateB;
                }

                // Apply sort direction
                return sortDirection === 'asc' ? compareResult : -compareResult;
            });

            return sortedItems;
        }

        function setSortColumn(column) {
            if (sortColumn === column) {
                // Toggle direction if clicking the same column
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, default to ascending
                sortColumn = column;
                sortDirection = 'asc';
            }

            // Re-render the current file list with new sorting
            if (allFiles.length > 0) {
                displayFiles(allFiles);
            }
        }

        // Display files
        function displayFiles(items) {
            const fileList = document.getElementById('fileList');
            fileList.innerHTML = '';

            // Sort items before displaying
            const sortedItems = sortFiles(items);

            if (viewMode === 'grid') {
                fileList.className = 'file-grid';

                // Add parent directory entry if not in root
                if (currentDir !== '/') {
                    const parentDiv = createGridItem({
                        name: '..',
                        type: 'dir',
                        size: 0,
                        date: ''
                    });
                    parentDiv.classList.add('parent-dir');
                    fileList.appendChild(parentDiv);
                }

                sortedItems.forEach(item => {
                    // Set fullPath for top-level items as well
                    const itemFullPath = currentDir === '/' ? '/' + item.name : currentDir + '/' + item.name;
                    const div = createGridItem(item, itemFullPath);
                    fileList.appendChild(div);
                });
            } else {
                fileList.className = 'file-list-table';

                // Add header
                const header = document.createElement('div');
                header.className = 'file-list-header';

                // Create sortable headers
                const getSortIndicator = (column) => {
                    if (sortColumn !== column) return '↕';
                    return sortDirection === 'asc' ? '↑' : '↓';
                };

                header.innerHTML = `
                    <div><input type="checkbox" id="selectAllCheckbox" title="Select All"></div>
                    <div></div>
                    <div></div>
                    <div class="sortable-header ${sortColumn === 'name' ? 'active' : ''}" data-column="name">
                        <span>NAME</span>
                        <span class="sort-indicator">${getSortIndicator('name')}</span>
                    </div>
                    <div class="sortable-header file-extension ${sortColumn === 'extension' ? 'active' : ''}" data-column="extension">
                        <span>EXTENSION</span>
                        <span class="sort-indicator">${getSortIndicator('extension')}</span>
                    </div>
                    <div class="sortable-header ${sortColumn === 'size' ? 'active' : ''}" data-column="size">
                        <span>SIZE</span>
                        <span class="sort-indicator">${getSortIndicator('size')}</span>
                    </div>
                    <div class="sortable-header file-date ${sortColumn === 'modified' ? 'active' : ''}" data-column="modified">
                        <span>MODIFIED</span>
                        <span class="sort-indicator">${getSortIndicator('modified')}</span>
                    </div>
                    <div class="file-actions">ACTIONS</div>
                `;

                // Add click handlers to sortable headers
                header.querySelectorAll('.sortable-header').forEach(headerCell => {
                    headerCell.addEventListener('click', () => {
                        const column = headerCell.getAttribute('data-column');
                        setSortColumn(column);
                    });
                });

                // Add select all checkbox handler
                const selectAllCheckbox = header.querySelector('#selectAllCheckbox');
                if (selectAllCheckbox) {
                    selectAllCheckbox.addEventListener('change', function(e) {
                        e.stopPropagation();
                        if (this.checked) {
                            selectAll();
                        } else {
                            clearSelection();
                        }
                    });
                }

                fileList.appendChild(header);

                // Add parent directory entry if not in root
                if (currentDir !== '/') {
                    const parentDiv = createListItem({
                        name: '..',
                        type: 'dir',
                        size: 0,
                        date: ''
                    });
                    parentDiv.classList.add('parent-dir');
                    fileList.appendChild(parentDiv);
                }

                sortedItems.forEach(item => {
                    // Set fullPath for top-level items as well
                    const itemFullPath = currentDir === '/' ? '/' + item.name : currentDir + '/' + item.name;
                    const div = createListItem(item, itemFullPath);
                    fileList.appendChild(div);
                });
            }
        }

        // Create grid item
        function createGridItem(item, fullPath = null) {
            const div = document.createElement('div');
            div.className = 'file-grid-item';
            div.dataset.name = item.name;
            div.dataset.type = item.type;

            // Store full path for nested items
            if (fullPath) {
                div.dataset.fullPath = fullPath;
            }

            // Hide checkbox for parent directory
            const checkboxHtml = item.name === '..' ? '' : '<input type="checkbox" class="file-grid-checkbox" onclick="toggleSelection(this, event)">';

            div.innerHTML = `
                ${checkboxHtml}
                <div class="file-grid-icon">${getFileIcon(item)}</div>
                <div class="file-grid-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                <div class="file-grid-size">${item.type === 'dir' ? '' : formatSize(item.size)}</div>
            `;

            // Long press detection for mobile
            let longPressTimer = null;
            let longPressTriggered = false;
            let isTouchDevice = false;

            div.addEventListener('touchstart', (e) => {
                isTouchDevice = true;

                if (e.target.type === 'checkbox' || e.target.classList.contains('file-grid-checkbox')) {
                    return;
                }

                longPressTriggered = false;
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    // Show context menu on long press
                    showContextMenu(e.touches[0], item.name, item.type, div.dataset.fullPath || null);
                }, 500); // 500ms long press
            });

            div.addEventListener('touchmove', (e) => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            });

            div.addEventListener('touchend', (e) => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }

                // If long press was triggered, prevent further action
                if (longPressTriggered) {
                    e.preventDefault();
                    longPressTriggered = false;
                    return;
                }

                // Single tap on directory navigates - only if tapping on icon or name
                if (e.target.type === 'checkbox' || e.target.classList.contains('file-grid-checkbox')) {
                    return;
                }

                // Set keyboard focus on tapped item for continued keyboard navigation
                const items = getFileItems();
                const tappedIndex = items.indexOf(div);
                if (tappedIndex >= 0) {
                    focusFileItem(tappedIndex);
                }

                // Only navigate if tapping on icon or name elements in grid view
                if (e.target.classList.contains('file-grid-icon') ||
                    e.target.classList.contains('file-grid-name') ||
                    e.target.closest('.file-grid-icon') ||
                    e.target.closest('.file-grid-name')) {
                    if (item.type === 'dir') {
                        if (item.name === '..') {
                            const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                            navigateTo(parentDir);
                        } else {
                            // Use fullPath from dataset if available (for nested items)
                            const folderPath = div.dataset.fullPath || (currentDir + '/' + item.name);
                            navigateTo(folderPath);
                        }
                    }
                }
            });

            // Single click for directories on desktop
            div.onclick = (e) => {
                // Skip if clicking on checkbox
                if (e.target.type === 'checkbox' || e.target.classList.contains('file-grid-checkbox')) {
                    return;
                }

                // Set keyboard focus on clicked item for continued keyboard navigation
                const items = getFileItems();
                const clickedIndex = items.indexOf(div);
                if (clickedIndex >= 0) {
                    focusFileItem(clickedIndex);
                }

                // Only navigate if clicking on icon or name elements in grid view
                if (e.target.classList.contains('file-grid-icon') ||
                    e.target.classList.contains('file-grid-name') ||
                    e.target.closest('.file-grid-icon') ||
                    e.target.closest('.file-grid-name')) {
                    if (item.type === 'dir') {
                        if (item.name === '..') {
                            // Navigate to parent directory
                            const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                            navigateTo(parentDir);
                        } else {
                            navigateTo(currentDir + '/' + item.name);
                        }
                    }
                }
            };

            // Double click for files on desktop (disabled on touch devices)
            div.ondblclick = (e) => {
                if (!isTouchDevice && item.type === 'file') {
                    // Use fullPath from dataset if available (for nested items)
                    const filePath = div.dataset.fullPath || null;
                    editFile(item.name, filePath);
                }
            };

            // Add right-click context menu
            if (item.name !== '..') {
                div.oncontextmenu = (e) => {
                    showContextMenu(e, item.name, item.type, div.dataset.fullPath || null);
                };
            }

            // Setup drag and drop events
            setupDragEvents(div, item.name, item.type);

            return div;
        }

        // Create list item
        function createListItem(item, fullPath = null) {
            const div = document.createElement('div');
            div.className = 'file-list-item';
            div.dataset.name = item.name;
            div.dataset.type = item.type;

            // Store full path for nested items
            if (fullPath) {
                div.dataset.fullPath = fullPath;
            }

            // Hide checkbox and actions for parent directory
            const checkboxHtml = item.name === '..' ? '<div></div>' : '<div><input type="checkbox" class="file-checkbox" onclick="toggleSelection(this, event)"></div>';
            const actionsHtml = item.name === '..' ? '<div class="file-actions"></div>' : `
                <div class="file-actions">
                    ${item.type === 'file' ? '<button class="action-btn" onclick="editFileFromTree(this)" title="Edit"><i class="fas fa-edit"></i></button>' : ''}
                    ${item.type === 'file' ? '<button class="action-btn" onclick="downloadFileFromTree(this, event)" title="Download"><i class="fas fa-download"></i></button>' : '<button class="action-btn" onclick="downloadFolderFromTree(this, event)" title="Download Folder as ZIP"><i class="fas fa-file-archive"></i></button>'}
                    <button class="action-btn" onclick="renameItemFromTree(this, event)" title="Rename"><i class="fas fa-edit"></i></button>
                    <button class="action-btn" onclick="copyItemFromTree(this, event)" title="Copy"><i class="fas fa-copy"></i></button>
                    <button class="action-btn" onclick="moveItemFromTree(this, event)" title="Move"><i class="fas fa-arrows-alt"></i></button>
                    <button class="action-btn" onclick="deleteItemFromTree(this, event)" title="Delete"><i class="fas fa-trash"></i></button>
                </div>
            `;

            const extension = item.type === 'file' ? getFileExtension(item.name) : '-';

            // Add expand icon for folders (except parent directory)
            const expandIconHtml = (item.type === 'dir' && item.name !== '..') ?
                '<div class="folder-expand-icon" data-folder-name="' + escapeHtml(item.name) + '"><i class="fas fa-chevron-right"></i></div>' :
                '<div></div>';

            div.innerHTML = `
                ${checkboxHtml}
                ${expandIconHtml}
                <div class="file-icon">${getFileIcon(item)}</div>
                <div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                <div class="file-extension">${extension || '-'}</div>
                <div class="file-size">${item.type === 'dir' ? '-' : formatSize(item.size)}</div>
                <div class="file-date">${item.date || item.modified || ''}</div>
                ${actionsHtml}
            `;

            // Long press detection for mobile
            let longPressTimer = null;
            let longPressTriggered = false;
            let isTouchDevice = false;

            div.addEventListener('touchstart', (e) => {
                isTouchDevice = true;

                // Don't interfere with checkboxes or action buttons
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('file-checkbox') ||
                    e.target.closest('.action-btn') ||
                    e.target.closest('.file-actions')) {
                    return;
                }

                longPressTriggered = false;
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    // Show context menu on long press
                    showContextMenu(e.touches[0], item.name, item.type, div.dataset.fullPath || null);
                }, 500); // 500ms long press
            });

            div.addEventListener('touchmove', (e) => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            });

            div.addEventListener('touchend', (e) => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }

                // If long press was triggered, prevent further action
                if (longPressTriggered) {
                    e.preventDefault();
                    longPressTriggered = false;
                    return;
                }

                // Single tap on directory navigates - only if tapping on icon or name
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('file-checkbox') ||
                    e.target.closest('.action-btn') ||
                    e.target.closest('.file-actions')) {
                    return;
                }

                // Set keyboard focus on tapped item for continued keyboard navigation
                const items = getFileItems();
                const tappedIndex = items.indexOf(div);
                if (tappedIndex >= 0) {
                    focusFileItem(tappedIndex);
                }

                // Only navigate if tapping on icon or name elements
                if (e.target.classList.contains('file-icon') ||
                    e.target.classList.contains('file-name') ||
                    e.target.closest('.file-icon') ||
                    e.target.closest('.file-name')) {
                    if (item.type === 'dir') {
                        if (item.name === '..') {
                            const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                            navigateTo(parentDir);
                        } else {
                            // Use fullPath from dataset if available (for nested items)
                            const folderPath = div.dataset.fullPath || (currentDir + '/' + item.name);
                            navigateTo(folderPath);
                        }
                    }
                }
            });

            // Single click for directories on desktop
            div.onclick = (e) => {
                // Skip if clicking on checkbox or action buttons
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('file-checkbox') ||
                    e.target.closest('.action-btn') ||
                    e.target.closest('.file-actions')) {
                    return;
                }

                // Set keyboard focus on clicked item for continued keyboard navigation
                const items = getFileItems();
                const clickedIndex = items.indexOf(div);
                if (clickedIndex >= 0) {
                    focusFileItem(clickedIndex);
                }

                // Only navigate if clicking on icon or name elements in list view
                if (e.target.classList.contains('file-icon') ||
                    e.target.classList.contains('file-name') ||
                    e.target.closest('.file-icon') ||
                    e.target.closest('.file-name')) {
                    if (item.type === 'dir') {
                        if (item.name === '..') {
                            // Navigate to parent directory
                            const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                            navigateTo(parentDir);
                        } else {
                            // Use fullPath from dataset if available (for nested items)
                            const folderPath = div.dataset.fullPath || (currentDir === '/' ? '/' + item.name : currentDir + '/' + item.name);
                            navigateTo(folderPath);
                        }
                    }
                }
            };

            // Double click for files on desktop (disabled on touch devices)
            div.ondblclick = (e) => {
                if (!isTouchDevice && item.type === 'file') {
                    // Use fullPath from dataset if available (for nested items)
                    const filePath = div.dataset.fullPath || null;
                    editFile(item.name, filePath);
                }
            };

            // Add right-click context menu
            if (item.name !== '..') {
                div.oncontextmenu = (e) => {
                    showContextMenu(e, item.name, item.type, div.dataset.fullPath || null);
                };
            }

            // Setup folder expand/collapse
            if (item.type === 'dir' && item.name !== '..') {
                const expandIcon = div.querySelector('.folder-expand-icon');
                if (expandIcon) {
                    expandIcon.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Set keyboard focus on folder for continued keyboard navigation
                        const items = getFileItems();
                        const clickedIndex = items.indexOf(div);
                        if (clickedIndex >= 0) {
                            focusFileItem(clickedIndex);
                        }
                        toggleFolderExpansion(div, item.name, expandIcon);
                    });
                }
            }

            // Setup drag and drop events
            setupDragEvents(div, item.name, item.type);

            return div;
        }

        // Get file icon
        function getFileIcon(item) {
            if (item.type === 'dir') {
                if (item.name === '..') {
                    return '<i class="fas fa-arrow-up"></i>'; // Up arrow for parent directory
                }
                return '<i class="fas fa-folder"></i>';
            }

            const filename = item.name.toLowerCase();

            // Special files
            if (filename === '.htaccess') return '<i class="fas fa-cog"></i>';
            if (filename === '.htpasswd') return '<i class="fas fa-lock"></i>';
            if (filename === '.gitignore') return '<i class="fab fa-git-alt"></i>';
            if (filename === '.env') return '<i class="fas fa-cog"></i>';
            if (filename === 'dockerfile') return '<i class="fab fa-docker"></i>';
            if (filename === 'makefile') return '<i class="fas fa-hammer"></i>';
            if (filename.startsWith('readme')) return '<i class="fas fa-book-open"></i>';
            if (filename.startsWith('license')) return '<i class="fas fa-certificate"></i>';
            if (filename.startsWith('changelog')) return '<i class="fas fa-clipboard-list"></i>';

            const ext = item.name.split('.').pop().toLowerCase();
            const icons = {
                'txt': '<i class="fas fa-file-alt"></i>', 'pdf': '<i class="fas fa-file-pdf"></i>', 'doc': '<i class="fas fa-file-word"></i>', 'docx': '<i class="fas fa-file-word"></i>',
                'xls': '<i class="fas fa-file-excel"></i>', 'xlsx': '<i class="fas fa-file-excel"></i>', 'jpg': '<i class="fas fa-file-image"></i>', 'png': '<i class="fas fa-file-image"></i>', 'gif': '<i class="fas fa-file-image"></i>',
                'mp3': '<i class="fas fa-file-audio"></i>', 'mp4': '<i class="fas fa-file-video"></i>', 'avi': '<i class="fas fa-file-video"></i>', 'mov': '<i class="fas fa-file-video"></i>',
                'zip': '<i class="fas fa-file-archive"></i>', 'rar': '<i class="fas fa-file-archive"></i>', '7z': '<i class="fas fa-file-archive"></i>', 'tar': '<i class="fas fa-file-archive"></i>', 'gz': '<i class="fas fa-file-archive"></i>',
                'html': '<i class="fab fa-html5"></i>', 'htm': '<i class="fab fa-html5"></i>', 'css': '<i class="fab fa-css3-alt"></i>', 'js': '<i class="fab fa-js-square"></i>', 'ts': '<i class="fab fa-js-square"></i>',
                'php': '<i class="fab fa-php"></i>', 'py': '<i class="fab fa-python"></i>', 'java': '<i class="fab fa-java"></i>', 'c': '<i class="fas fa-file-code"></i>', 'cpp': '<i class="fas fa-file-code"></i>',
                'json': '<i class="fas fa-file-code"></i>', 'xml': '<i class="fas fa-file-code"></i>', 'yaml': '<i class="fas fa-file-code"></i>', 'yml': '<i class="fas fa-file-code"></i>',
                'md': '<i class="fab fa-markdown"></i>', 'sql': '<i class="fas fa-database"></i>', 'log': '<i class="fas fa-file-alt"></i>', 'conf': '<i class="fas fa-cog"></i>', 'ini': '<i class="fas fa-cog"></i>'
            };

            return icons[ext] || '<i class="fas fa-file"></i>';
        }

        // Format file size
        function formatSize(bytes) {
            // Convert to number and handle edge cases
            bytes = parseInt(bytes) || 0;
            if (bytes === 0) return '0 B';
            
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            
            // Safeguard against invalid values
            if (i < 0 || isNaN(i)) return '0 B';
            
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        }

        // Toggle selection
        function toggleSelection(checkbox, event) {
            event.stopPropagation();
            const item = checkbox.closest('.file-grid-item, .file-list-item');
            const name = item.dataset.name;
            const type = item.dataset.type;

            if (checkbox.checked) {
                item.classList.add('selected');
                if (!selectedItems.find(i => i.name === name)) {
                    // Store fullPath and parentPath for nested items
                    const itemData = {name, type};
                    if (item.dataset.fullPath) {
                        itemData.fullPath = item.dataset.fullPath;
                    }
                    if (item.dataset.parentPath) {
                        itemData.parentPath = item.dataset.parentPath;
                    }
                    selectedItems.push(itemData);
                }
            } else {
                item.classList.remove('selected');
                selectedItems = selectedItems.filter(i => i.name !== name);
            }

            updateStatus();
            updateSelectAllCheckbox();
        }

        // Select all
        function selectAll() {
            selectedItems = [];
            const checkboxes = document.querySelectorAll('.file-checkbox, .file-grid-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = true;
                const item = cb.closest('.file-grid-item, .file-list-item');
                item.classList.add('selected');

                // Build item data with fullPath if available
                const itemData = {
                    name: item.dataset.name,
                    type: item.dataset.type
                };
                if (item.dataset.fullPath) {
                    itemData.fullPath = item.dataset.fullPath;
                }
                if (item.dataset.parentPath) {
                    itemData.parentPath = item.dataset.parentPath;
                }
                selectedItems.push(itemData);
            });

            updateStatus();
            updateSelectAllCheckbox();
        }

        // Clear all selections
        function clearSelection() {
            const checkboxes = document.querySelectorAll('.file-checkbox, .file-grid-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = false;
                const item = cb.closest('.file-grid-item, .file-list-item');
                if (item) item.classList.remove('selected');
            });

            selectedItems = [];
            updateStatus();
            updateSelectAllCheckbox();
        }

        // Update select all checkbox state based on current selection
        function updateSelectAllCheckbox() {
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            if (!selectAllCheckbox) return;

            const totalFiles = allFiles.length;
            const selectedCount = selectedItems.length;

            if (selectedCount === 0) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = false;
            } else if (selectedCount === totalFiles) {
                selectAllCheckbox.checked = true;
                selectAllCheckbox.indeterminate = false;
            } else {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.indeterminate = true;
            }
        }

        // Drag to select functionality
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragRect = null;
        let initialSelection = [];

        function initDragSelection() {
            const fileList = document.getElementById('fileList');
            if (!fileList) return;

            fileList.addEventListener('mousedown', (e) => {
                // Only handle left mouse button (not right-click for context menu)
                if (e.button !== 0) {
                    return;
                }

                // Don't start drag if clicking on checkbox, button, or link
                if (e.target.type === 'checkbox' ||
                    e.target.classList.contains('file-checkbox') ||
                    e.target.classList.contains('file-grid-checkbox') ||
                    e.target.tagName === 'BUTTON' ||
                    e.target.tagName === 'A' ||
                    e.target.closest('button') ||
                    e.target.closest('a') ||
                    e.target.classList.contains('breadcrumb-link') ||
                    e.target.classList.contains('action-btn')) {
                    return;
                }

                // Don't start drag selection if clicking on a SELECTED item (for drag-and-drop move)
                const clickedItem = e.target.closest('.file-grid-item, .file-list-item');
                if (clickedItem && clickedItem.classList.contains('selected')) {
                    return;
                }

                // Only start drag selection on file list background or file items
                if (e.target.classList.contains('file-grid') ||
                    e.target.classList.contains('file-list-table') ||
                    e.target.classList.contains('file-grid-item') ||
                    e.target.classList.contains('file-list-item') ||
                    e.target.classList.contains('file-grid-icon') ||
                    e.target.classList.contains('file-grid-name') ||
                    e.target.classList.contains('file-grid-size') ||
                    e.target.closest('.file-grid-item') ||
                    e.target.closest('.file-list-item')) {

                    isDragging = true;
                    dragStartX = e.clientX;
                    dragStartY = e.clientY;

                    // Clear previous selection when starting new drag
                    const checkboxes = document.querySelectorAll('.file-checkbox, .file-grid-checkbox');
                    checkboxes.forEach(cb => {
                        cb.checked = false;
                        const item = cb.closest('.file-grid-item, .file-list-item');
                        if (item) item.classList.remove('selected');
                    });
                    selectedItems = [];
                    initialSelection = [];
                    updateStatus();

                    // Create drag rectangle
                    dragRect = document.createElement('div');
                    dragRect.className = 'drag-selection-rect';
                    document.body.appendChild(dragRect);
                    document.body.classList.add('drag-selecting');

                    e.preventDefault();
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging || !dragRect) return;

                const currentX = e.clientX;
                const currentY = e.clientY;

                // Calculate rectangle bounds
                const left = Math.min(dragStartX, currentX);
                const top = Math.min(dragStartY, currentY);
                const width = Math.abs(currentX - dragStartX);
                const height = Math.abs(currentY - dragStartY);

                // Update drag rectangle
                dragRect.style.left = left + 'px';
                dragRect.style.top = top + 'px';
                dragRect.style.width = width + 'px';
                dragRect.style.height = height + 'px';

                // Check for intersections with file items
                const rectBounds = {
                    left: left,
                    top: top,
                    right: left + width,
                    bottom: top + height
                };

                updateDragSelection(rectBounds);
            });

            document.addEventListener('mouseup', (e) => {
                if (!isDragging) return;

                isDragging = false;

                // Remove drag rectangle
                if (dragRect) {
                    dragRect.remove();
                    dragRect = null;
                }

                document.body.classList.remove('drag-selecting');
            });
        }

        function updateDragSelection(rectBounds) {
            const items = document.querySelectorAll('.file-grid-item, .file-list-item');
            const newSelection = [];

            items.forEach(item => {
                const name = item.dataset.name;
                const type = item.dataset.type;

                // Skip parent directory
                if (name === '..') return;

                const itemBounds = item.getBoundingClientRect();
                const intersects = !(
                    itemBounds.right < rectBounds.left ||
                    itemBounds.left > rectBounds.right ||
                    itemBounds.bottom < rectBounds.top ||
                    itemBounds.top > rectBounds.bottom
                );

                const checkbox = item.querySelector('.file-checkbox, .file-grid-checkbox');

                if (intersects) {
                    // Item is within selection rectangle
                    if (!item.classList.contains('selected')) {
                        item.classList.add('selected');
                        if (checkbox) checkbox.checked = true;
                    }
                    if (!newSelection.find(i => i.name === name)) {
                        // Store fullPath and parentPath for nested items
                        const itemData = {name, type};
                        if (item.dataset.fullPath) {
                            itemData.fullPath = item.dataset.fullPath;
                        }
                        if (item.dataset.parentPath) {
                            itemData.parentPath = item.dataset.parentPath;
                        }
                        newSelection.push(itemData);
                    }
                } else {
                    // Item is outside selection rectangle - deselect it
                    item.classList.remove('selected');
                    if (checkbox) checkbox.checked = false;
                }
            });

            selectedItems = newSelection;
            updateStatus();
            updateSelectAllCheckbox();
        }

        // Drag and drop to move files
        let draggedItems = [];
        let autoScrollInterval = null;

        function initDragAndDrop() {
            // This will be called when file list is refreshed
            // Handled in displayFiles functions
        }

        // Auto-scroll when dragging near file list edges
        function initAutoScroll() {
            let isScrolling = false;
            let scrollAmount = 0;
            let animationFrameId = null;

            function autoScroll() {
                if (!isScrolling || scrollAmount === 0) {
                    animationFrameId = requestAnimationFrame(autoScroll);
                    return;
                }

                const fileListContainer = document.querySelector('.file-list-container');
                if (fileListContainer) {
                    fileListContainer.scrollBy(0, scrollAmount);
                }

                // Continue the animation loop
                animationFrameId = requestAnimationFrame(autoScroll);
            }

            document.addEventListener('dragover', (e) => {
                if (draggedItems.length === 0) return;

                const fileListContainer = document.querySelector('.file-list-container');
                if (!fileListContainer) return;

                // Get file list container bounds
                const containerRect = fileListContainer.getBoundingClientRect();
                const mouseY = e.clientY;

                // Calculate position relative to container
                const relativeY = mouseY - containerRect.top;
                const containerHeight = containerRect.height;

                const scrollThreshold = 100; // pixels from edge
                const maxScrollSpeed = 3; // Gentle scrolling speed

                let newScrollAmount = 0;

                // Check if near top of container
                if (relativeY < scrollThreshold && relativeY > 0) {
                    // Near top - scroll up
                    // Use square root for gentler acceleration curve
                    const proximity = (scrollThreshold - relativeY) / scrollThreshold;
                    const easedProximity = Math.sqrt(proximity);
                    newScrollAmount = -easedProximity * maxScrollSpeed;
                }
                // Check if near bottom of container
                else if (relativeY > containerHeight - scrollThreshold && relativeY < containerHeight) {
                    // Near bottom - scroll down
                    // Use square root for gentler acceleration curve
                    const proximity = (relativeY - (containerHeight - scrollThreshold)) / scrollThreshold;
                    const easedProximity = Math.sqrt(proximity);
                    newScrollAmount = easedProximity * maxScrollSpeed;
                }

                scrollAmount = newScrollAmount;

                // Start animation loop if not already running
                if (!isScrolling && scrollAmount !== 0) {
                    isScrolling = true;
                    autoScroll();
                } else if (isScrolling && scrollAmount === 0) {
                    isScrolling = false;
                }
            });

            function stopScrolling() {
                isScrolling = false;
                scrollAmount = 0;
                if (animationFrameId) {
                    cancelAnimationFrame(animationFrameId);
                    animationFrameId = null;
                }
            }

            document.addEventListener('dragend', stopScrolling);
            document.addEventListener('drop', stopScrolling);
        }

        // Initialize auto-scroll on page load
        initAutoScroll();

        // Setup drop zones for breadcrumb items (each folder in path)
        function initBreadcrumbDropZones() {
            const breadcrumbItems = document.querySelectorAll('.breadcrumb-drop-target');

            breadcrumbItems.forEach(item => {
                const targetPath = item.dataset.path;

                // Handle dragover on individual breadcrumb item
                item.addEventListener('dragover', (e) => {
                    if (draggedItems.length === 0) return;

                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    item.classList.add('breadcrumb-item-drop-active');
                });

                item.addEventListener('dragleave', (e) => {
                    // Only remove highlight if leaving this item completely
                    if (!item.contains(e.relatedTarget)) {
                        item.classList.remove('breadcrumb-item-drop-active');
                    }
                });

                // Handle drop on individual breadcrumb item
                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    item.classList.remove('breadcrumb-item-drop-active');

                    if (draggedItems.length === 0) return;

                    // Move to the folder represented by this breadcrumb item
                    window.currentMoveItems = draggedItems.slice();
                    performDragDropMove(targetPath);
                });
            });
        }

        // Clean up breadcrumb highlights on drag end
        document.addEventListener('dragend', () => {
            document.querySelectorAll('.breadcrumb-item-drop-active').forEach(item => {
                item.classList.remove('breadcrumb-item-drop-active');
            });
        });

        function setupDragEvents(itemElement, itemName, itemType) {
            // Parent directory should be a drop target but not draggable
            if (itemName === '..') {
                // Make ".." a drop target for moving to parent directory
                itemElement.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    itemElement.classList.add('drag-over');
                });

                itemElement.addEventListener('dragleave', (e) => {
                    if (!itemElement.contains(e.relatedTarget)) {
                        itemElement.classList.remove('drag-over');
                    }
                });

                itemElement.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    itemElement.classList.remove('drag-over');

                    // Calculate parent directory path
                    const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';

                    // Store the items to move
                    window.currentMoveItems = draggedItems.slice();

                    // Perform the move operation to parent directory
                    performDragDropMove(parentDir);
                });

                return; // Don't make it draggable
            }

            // Make item draggable
            itemElement.setAttribute('draggable', 'true');

            itemElement.addEventListener('dragstart', (e) => {
                // Check if this item is selected
                const isSelected = selectedItems.some(item => item.name === itemName);

                if (isSelected && selectedItems.length > 0) {
                    // Drag all selected items - need to get fullPath from each DOM element
                    draggedItems = selectedItems.map(item => {
                        // Find the DOM element for this item to get its fullPath
                        const itemEl = document.querySelector(`.file-list-item[data-name="${item.name}"], .file-grid-item[data-name="${item.name}"]`);
                        const itemFullPath = itemEl ? itemEl.dataset.fullPath : null;
                        return {
                            name: item.name,
                            type: item.type,
                            fullPath: itemFullPath
                        };
                    });
                } else {
                    // Drag only this item - get fullPath from dataset if available
                    const itemFullPath = itemElement.dataset.fullPath || null;
                    draggedItems = [{name: itemName, type: itemType, fullPath: itemFullPath}];
                }

                // Add dragging class to all selected items
                if (draggedItems.length > 1) {
                    document.querySelectorAll('.file-grid-item.selected, .file-list-item.selected').forEach(el => {
                        el.classList.add('dragging');
                    });
                } else {
                    itemElement.classList.add('dragging');
                }

                // Create custom drag image for multiple items
                if (draggedItems.length > 1) {
                    const dragImage = document.createElement('div');
                    dragImage.style.position = 'absolute';
                    dragImage.style.top = '-1000px';
                    dragImage.style.padding = '10px 15px';
                    dragImage.style.background = 'var(--accent-color)';
                    dragImage.style.color = 'white';
                    dragImage.style.borderRadius = '8px';
                    dragImage.style.fontWeight = 'bold';
                    dragImage.style.fontSize = '14px';
                    dragImage.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
                    dragImage.innerHTML = `<i class="fas fa-copy"></i> ${draggedItems.length} items`;
                    document.body.appendChild(dragImage);

                    // Set the custom drag image
                    e.dataTransfer.setDragImage(dragImage, 50, 25);

                    // Remove the drag image after a short delay
                    setTimeout(() => {
                        document.body.removeChild(dragImage);
                    }, 0);
                }

                // Set drag data
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', JSON.stringify(draggedItems));
            });

            itemElement.addEventListener('dragend', (e) => {
                // Remove dragging class from all items
                document.querySelectorAll('.dragging').forEach(el => {
                    el.classList.remove('dragging');
                });
                // Remove drag-over class from all items
                document.querySelectorAll('.drag-over').forEach(el => {
                    el.classList.remove('drag-over');
                });
            });

            // Only folders can be drop targets
            if (itemType === 'dir') {
                itemElement.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    // Don't allow dropping on itself
                    if (draggedItems.some(item => item.name === itemName)) {
                        e.dataTransfer.dropEffect = 'none';
                        return;
                    }

                    e.dataTransfer.dropEffect = 'move';
                    itemElement.classList.add('drag-over');
                });

                itemElement.addEventListener('dragleave', (e) => {
                    // Only remove if leaving the element completely
                    if (!itemElement.contains(e.relatedTarget)) {
                        itemElement.classList.remove('drag-over');
                    }
                });

                itemElement.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    itemElement.classList.remove('drag-over');

                    // Don't allow dropping on itself
                    if (draggedItems.some(item => item.name === itemName)) {
                        return;
                    }

                    // Get the destination path - use fullPath from dataset if available
                    const destinationPath = itemElement.dataset.fullPath || (currentDir + '/' + itemName);

                    // Store the items to move
                    window.currentMoveItems = draggedItems.slice();

                    // Perform the move operation directly
                    performDragDropMove(destinationPath);
                });
            }
        }

        function performDragDropMove(destinationPath) {
            if (!window.currentMoveItems || window.currentMoveItems.length === 0) {
                return;
            }

            const itemCount = window.currentMoveItems.length;

            // Extract folder name from destination path
            const folderName = destinationPath.split('/').filter(p => p).pop() || '/';

            if (!confirm(`Move ${itemCount} item(s) to folder "${folderName}"`)) {
                return;
            }

            showLoader();

            // Move items sequentially
            let successCount = 0;
            let errorCount = 0;
            let currentIndex = 0;

            function moveNextItem() {
                if (currentIndex >= window.currentMoveItems.length) {
                    // All items processed
                    hideLoader();

                    if (successCount > 0) {
                        selectedItems = []; // Clear selection
                        refreshList();

                        if (errorCount > 0) {
                            alert('Moved ' + successCount + ' items successfully, ' + errorCount + ' failed');
                        }
                    } else {
                        alert('Failed to move any items');
                    }
                    return;
                }

                const item = window.currentMoveItems[currentIndex];
                let oldPath = item.fullPath || (currentDir + '/' + item.name);
                let newPath = destinationPath + '/' + item.name;

                // Remove leading slashes for FTP paths
                oldPath = oldPath.replace(/^\/+/, '');
                newPath = newPath.replace(/^\/+/, '');

                fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=move&oldPath=' + encodeURIComponent(oldPath) +
                          '&newPath=' + encodeURIComponent(newPath) +
                          '&type=' + item.type
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        successCount++;
                    } else {
                        errorCount++;
                    }
                    currentIndex++;
                    moveNextItem();
                })
                .catch(error => {
                    errorCount++;
                    currentIndex++;
                    moveNextItem();
                });
            }

            moveNextItem();
        }

        // Helper function to get the correct path for an item
        function getItemPath(nameOrElement) {
            // If it's a string (name), use current directory
            if (typeof nameOrElement === 'string') {
                return currentDir + '/' + nameOrElement;
            }

            // If it's an element or event, find the list item and check for full path
            let element = nameOrElement;
            if (nameOrElement.target) {
                element = nameOrElement.target;
            }

            const listItem = element.closest('.file-list-item');
            if (listItem && listItem.dataset.fullPath) {
                return listItem.dataset.fullPath;
            }

            // Fallback to current directory + name
            if (listItem && listItem.dataset.name) {
                return currentDir + '/' + listItem.dataset.name;
            }

            return null;
        }

        // Wrapper functions for tree operations
        function editFileFromTree(element) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            editFile(name, path);
        }

        function downloadFileFromTree(element, event) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            downloadFile(name, event, path);
        }

        function downloadFolderFromTree(element, event) {
            const listItem = element.closest('.file-list-item');

            // Determine the full path - try multiple strategies
            let path;
            if (listItem.dataset.fullPath) {
                // Best case: fullPath is already set
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                // Nested item: reconstruct from parentPath + name
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                // Fallback: construct from currentDir
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }

            const name = listItem.dataset.name;
            downloadFolder(name, event, path);
        }

        function renameItemFromTree(element, event) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            renameItem(name, event, path);
        }

        function copyItemFromTree(element, event) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            const type = listItem.dataset.type;
            copyItem(name, type, event, path);
        }

        function moveItemFromTree(element, event) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            const type = listItem.dataset.type;
            moveItem(name, type, event, path);
        }

        function deleteItemFromTree(element, event) {
            const listItem = element.closest('.file-list-item');
            // Robust path reconstruction
            let path;
            if (listItem.dataset.fullPath) {
                path = listItem.dataset.fullPath;
            } else if (listItem.dataset.parentPath) {
                path = listItem.dataset.parentPath + '/' + listItem.dataset.name;
            } else {
                path = currentDir === '/' ? '/' + listItem.dataset.name : currentDir + '/' + listItem.dataset.name;
            }
            const name = listItem.dataset.name;
            const type = listItem.dataset.type;
            deleteItem(name, type, event, path);
        }

        // Navigate to directory
        function navigateTo(dir) {
            currentDir = dir.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
            selectedItems = [];

            // Update URL with current directory for bookmarking
            updateURL();

            refreshList();
        }

        // Folder expansion state tracking
        const expandedFolders = new Map(); // Map<fullPath, boolean>

        // Toggle folder expansion
        async function toggleFolderExpansion(folderElement, folderName, expandIcon) {
            // Use fullPath from dataset if available (for nested items), otherwise construct from currentDir
            const folderPath = folderElement.dataset.fullPath || (currentDir === '/' ? '/' + folderName : currentDir + '/' + folderName);

            const isExpanded = expandedFolders.get(folderPath);

            if (isExpanded) {
                // Collapse folder
                collapseFolderContents(folderElement, folderPath);
                expandIcon.classList.remove('expanded');
                expandedFolders.set(folderPath, false);
            } else {
                // Expand folder
                expandIcon.classList.add('loading');
                await loadFolderContents(folderElement, folderName, folderPath);
                expandIcon.classList.remove('loading');
                expandIcon.classList.add('expanded');
                expandedFolders.set(folderPath, true);
            }
        }

        // Load and display folder contents
        async function loadFolderContents(parentElement, folderName, folderPath) {
            try {
                const response = await fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=list&dir=' + encodeURIComponent(folderPath)
                });

                const data = await response.json();

                if (data.success && data.items) {
                    // Get the parent's depth
                    const parentDepth = parseInt(parentElement.dataset.depth || '0');
                    const childDepth = parentDepth + 1;

                    // Filter out parent directory
                    const items = data.items.filter(item => item.name !== '..');

                    // Insert child items after the parent
                    items.forEach((item, index) => {
                        const itemFullPath = folderPath === '/' ? '/' + item.name : folderPath + '/' + item.name;
                        const childItem = createListItem(item, itemFullPath);
                        childItem.dataset.depth = childDepth;
                        childItem.dataset.parentPath = folderPath;
                        childItem.classList.add('nested');
                        childItem.style.setProperty('--indent-level', childDepth);

                        // Insert after parent (and any previous siblings)
                        const nextSibling = parentElement.nextElementSibling;
                        if (nextSibling) {
                            parentElement.parentNode.insertBefore(childItem, nextSibling);
                        } else {
                            parentElement.parentNode.appendChild(childItem);
                        }

                        // Move to next position for next item
                        if (index < items.length - 1) {
                            parentElement = childItem;
                        }
                    });
                }
            } catch (error) {
                console.error('Error loading folder contents:', error);
                alert('Failed to load folder contents');
            }
        }

        // Collapse folder and remove its contents
        function collapseFolderContents(folderElement, folderPath) {
            let nextElement = folderElement.nextElementSibling;

            while (nextElement) {
                const nextPath = nextElement.dataset.parentPath;

                // Check if this element is a child of the folder being collapsed
                if (nextPath && nextPath.startsWith(folderPath)) {
                    const toRemove = nextElement;
                    nextElement = nextElement.nextElementSibling;

                    // Also mark nested folders as collapsed
                    const nestedPath = nextPath + '/' + toRemove.dataset.name;
                    expandedFolders.set(nestedPath, false);

                    toRemove.remove();
                } else {
                    break;
                }
            }
        }

        // Update URL with current directory
        function updateURL() {
            const url = new URL(window.location);
            if (currentDir === '/') {
                url.searchParams.delete('home');
            } else {
                url.searchParams.set('home', currentDir);
            }
            window.history.replaceState({}, '', url);
        }

        // Update breadcrumb
        function updateBreadcrumb() {
            const breadcrumb = document.getElementById('breadcrumb');
            const parts = currentDir.split('/').filter(p => p);

            let html = '<div class="breadcrumb-item breadcrumb-drop-target" data-path="/"><span class="breadcrumb-link" onclick="navigateTo(\'/\')">Home</span></div>';

            let path = '';
            parts.forEach((part, index) => {
                path += '/' + part;
                html += '<div class="breadcrumb-item breadcrumb-drop-target" data-path="' + escapeHtml(path) + '"><span class="breadcrumb-link" onclick="navigateTo(\'' + escapeHtml(path) + '\')">' + escapeHtml(part) + '</span></div>';
            });

            breadcrumb.innerHTML = html;
            document.getElementById('currentPath').textContent = currentDir;

            // Re-initialize breadcrumb drop zones after updating
            initBreadcrumbDropZones();
        }

        // Update status
        function updateStatus() {
            document.getElementById('itemCount').textContent = allFiles.length + ' items';
            document.getElementById('selectedCount').textContent = selectedItems.length + ' selected';
        }

        // Search files
        function searchFiles() {
            const query = document.getElementById('searchInput').value.toLowerCase();
            
            if (!query) {
                displayFiles(allFiles);
                return;
            }
            
            const filtered = allFiles.filter(item => 
                item.name.toLowerCase().includes(query)
            );
            
            displayFiles(filtered);
        }

        // Set view mode
        function setView(mode) {
            viewMode = mode;
            
            document.getElementById('gridViewBtn').classList.toggle('active', mode === 'grid');
            document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
            
            // Save view mode preference to cookie
            setCookie('filemanager_viewmode', mode);
            
            displayFiles(allFiles);
            
            // Show feedback for manual changes
            if (document.readyState === 'complete') {
                showPreferenceMessage('View mode: ' + mode);
            }
        }

        // Toggle sidebar
        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            const isOpen = sidebar.classList.contains('open');
            
            if (isOpen) {
                closeSidebar();
            } else {
                openSidebar();
            }
        }

        // Open sidebar
        function openSidebar() {
            document.getElementById('sidebar').classList.add('open');
            
            // Show overlay on mobile
            if (window.innerWidth <= 1024) {
                document.getElementById('sidebarOverlay').classList.add('show');
            }
        }

        // Close sidebar
        function closeSidebar() {
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarOverlay').classList.remove('show');
        }
        
        // Close sidebar on mobile after navigation
        function closeSidebarOnMobile() {
            if (window.innerWidth <= 1024) {
                closeSidebar();
            }
        }

        // Mobile actions dropdown
        function toggleMobileActions() {
            const dropdown = document.getElementById('mobileActionsDropdown');
            const moreBtn = document.querySelector('.mobile-more-btn');
            
            if (!dropdown) {
                alert('Error: Dropdown element not found');
                return;
            }
            
            if (dropdown.style.display === 'block') {
                dropdown.style.display = 'none';
            } else {
                // Get the More button position
                const btnRect = moreBtn.getBoundingClientRect();
                
                // Show and position the dropdown
                dropdown.style.display = 'block';
                dropdown.style.position = 'fixed';
                dropdown.style.top = (btnRect.bottom + 5) + 'px';
                dropdown.style.right = '10px';
                dropdown.style.zIndex = '9999';
                dropdown.style.minWidth = '150px';
            }
        }

        function hideMobileActions() {
            document.getElementById('mobileActionsDropdown').style.display = 'none';
        }

        // Hide mobile dropdown and close sidebar when clicking outside
        document.addEventListener('click', function(event) {
            // Handle mobile actions dropdown
            const dropdown = document.getElementById('mobileActionsDropdown');
            const moreBtn = document.querySelector('.mobile-more-btn');
            
            if (dropdown && moreBtn && !dropdown.contains(event.target) && !moreBtn.contains(event.target)) {
                hideMobileActions();
            }
            
            // Handle sidebar closing on mobile
            const sidebar = document.getElementById('sidebar');
            const menuToggle = document.querySelector('.mobile-menu-toggle');
            
            // Only on mobile screens and if sidebar is open
            if (window.innerWidth <= 1024 && sidebar && sidebar.classList.contains('open')) {
                // Close if click is outside sidebar and not on the menu toggle button
                if (!sidebar.contains(event.target) && !menuToggle.contains(event.target)) {
                    closeSidebar();
                }
            }
        });

        // Toggle theme
        function toggleTheme() {
            const currentTheme = document.body.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

            // Update both html and body elements
            document.documentElement.setAttribute('data-theme', newTheme);
            document.body.setAttribute('data-theme', newTheme);

            // Save theme preference to cookie
            setCookie('filemanager_theme', newTheme);

            // Update CodeMirror theme if editor is open
            updateCodeMirrorTheme();

            showPreferenceMessage('Theme: ' + newTheme + ' mode');
        }

        // Show/hide loader
        function showLoader() {
            document.getElementById('loadingOverlay').style.display = 'flex';
        }

        function hideLoader() {
            document.getElementById('loadingOverlay').style.display = 'none';
        }

        // Modal functions
        function showModal(id) {
            document.getElementById(id).classList.add('show');
            
            // Mobile keyboard handling for editor
            if (id === 'editorModal' && window.innerWidth <= 768) {
                // Prevent body scrolling on mobile
                document.body.style.overflow = 'hidden';
                document.body.style.position = 'fixed';
                document.body.style.width = '100%';
                
                // Add class to handle viewport changes
                document.body.classList.add('editor-open-mobile');
            }
        }

        function closeModal(id) {
            document.getElementById(id).classList.remove('show');
            
            // Restore body scrolling on mobile
            if (id === 'editorModal' && window.innerWidth <= 768) {
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.style.width = '';
                document.body.classList.remove('editor-open-mobile');
            }
        }

        // Target directory for create/upload operations
        let targetOperationDir = null;

        function showUploadModal(targetDir = null) {
            targetOperationDir = targetDir || currentDir;
            // Reset to files mode
            setUploadType('files');
            showModal('uploadModal');
        }

        function showCreateDirModal(targetDir = null) {
            targetOperationDir = targetDir || currentDir;
            showModal('createDirModal');
            setTimeout(() => document.getElementById('dirName').focus(), 100);
        }

        function showCreateFileModal(targetDir = null) {
            targetOperationDir = targetDir || currentDir;
            showModal('createFileModal');
            setTimeout(() => document.getElementById('fileName').focus(), 100);
        }

        // Upload functionality
        let currentUploadType = 'files';

        function setUploadType(type) {
            currentUploadType = type;
            
            // Reset button states
            document.getElementById('filesTypeBtn').classList.remove('btn-primary');
            document.getElementById('folderTypeBtn').classList.remove('btn-primary');
            document.getElementById('zipExtractTypeBtn').classList.remove('btn-primary');
            
            document.getElementById('filesTypeBtn').classList.add('btn-light');
            document.getElementById('folderTypeBtn').classList.add('btn-light');
            document.getElementById('zipExtractTypeBtn').classList.add('btn-light');
            
            // Hide all sections
            document.getElementById('filesUploadSection').style.display = 'none';
            document.getElementById('folderUploadSection').style.display = 'none';
            document.getElementById('zipExtractUploadSection').style.display = 'none';
            
            // Show selected section and update button
            const uploadBtn = document.getElementById('uploadBtn');
            
            if (type === 'files') {
                document.getElementById('filesUploadSection').style.display = 'block';
                document.getElementById('filesTypeBtn').classList.remove('btn-light');
                document.getElementById('filesTypeBtn').classList.add('btn-primary');
                uploadBtn.style.display = 'inline-block';
                uploadBtn.textContent = 'Upload Files';
            } else if (type === 'folder') {
                document.getElementById('folderUploadSection').style.display = 'block';
                document.getElementById('folderTypeBtn').classList.remove('btn-light');
                document.getElementById('folderTypeBtn').classList.add('btn-primary');
                uploadBtn.style.display = 'none'; // Hide upload button - folders upload automatically
            } else if (type === 'zipExtract') {
                document.getElementById('zipExtractUploadSection').style.display = 'block';
                document.getElementById('zipExtractTypeBtn').classList.remove('btn-light');
                document.getElementById('zipExtractTypeBtn').classList.add('btn-primary');
                uploadBtn.style.display = 'inline-block';
                uploadBtn.textContent = 'Upload & Extract';
            }
        }

        function showUploadUnzipModal() {
            targetOperationDir = currentDir;
            // Set to zip extract mode
            setUploadType('zipExtract');
            showModal('uploadModal');
        }

        function performUpload() {
            if (currentUploadType === 'files') {
                uploadFiles();
            } else if (currentUploadType === 'folder') {
                uploadFolder();
            } else if (currentUploadType === 'zipExtract') {
                uploadAndExtract();
            }
        }

        async function uploadFiles() {
            const fileInput = document.getElementById('fileInput');
            const files = fileInput.files;

            if (!files.length) {
                alert('Please select files to upload');
                return;
            }

            showUploadProgress();
            let completedFiles = 0;
            const totalFiles = files.length;

            // Calculate total size for overall progress
            let totalSize = 0;
            let uploadedSize = 0;
            Array.from(files).forEach(file => totalSize += file.size);

            try {
                // Upload files sequentially for better progress tracking
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const fileSize = file.size;

                    // Create a promise for each file upload
                    await new Promise((resolve, reject) => {
                        const basePath = targetOperationDir || currentDir;

                        const formData = new FormData();
                        formData.append('action', 'upload');
                        formData.append('file', file);
                        formData.append('basePath', basePath);

                        const xhr = new XMLHttpRequest();

                        // Track upload progress for this file
                        xhr.upload.addEventListener('progress', (e) => {
                            if (e.lengthComputable) {
                                const fileProgress = e.loaded;
                                const totalProgress = uploadedSize + fileProgress;
                                const percentComplete = Math.round((totalProgress / totalSize) * 100);
                                const currentMB = ((uploadedSize + fileProgress) / 1048576).toFixed(2);
                                const totalMB = (totalSize / 1048576).toFixed(2);
                                updateUploadProgress(percentComplete, 100,
                                    `File ${i + 1}/${totalFiles}: ${file.name} (${currentMB}MB / ${totalMB}MB)`);
                            }
                        });

                        // Handle load event
                        xhr.addEventListener('load', () => {
                            if (xhr.status === 200) {
                                try {
                                    const data = JSON.parse(xhr.responseText);
                                    if (data.success) {
                                        uploadedSize += fileSize;
                                        completedFiles++;
                                        resolve(data);
                                    } else {
                                        console.error('Upload failed for:', file.name, data.error || 'Unknown error');
                                        reject(new Error(data.error || `Upload failed for ${file.name}`));
                                    }
                                } catch (e) {
                                    console.error('Parse error for file:', file.name, e);
                                    reject(e);
                                }
                            } else {
                                reject(new Error(`Upload failed for ${file.name}: ${xhr.status}`));
                            }
                        });

                        // Handle error event
                        xhr.addEventListener('error', () => {
                            reject(new Error(`Network error uploading ${file.name}`));
                        });

                        xhr.open('POST', window.location.href);
                        xhr.send(formData);
                    });
                }

                // All uploads complete successfully
                updateUploadProgress(100, 100, `All ${totalFiles} files uploaded successfully!`);
                setTimeout(() => {
                    closeModal('uploadModal');
                    refreshList();
                    resetUploadModal();
                }, 500);
            } catch (error) {
                // Upload failed - show error message
                console.error('Upload error:', error);
                alert(`Upload failed: ${error.message}`);
                hideUploadProgress();
            }
        }

        async function uploadFolder() {
            const folderInput = document.getElementById('folderInput');
            const files = folderInput.files;

            if (!files.length) {
                alert('Please select a folder to upload');
                return;
            }

            showUploadProgress();
            updateUploadProgress(0, 100, 'Preparing upload...');

            // Extract directory structure
            const directories = new Set();
            const filesList = Array.from(files);

            filesList.forEach(file => {
                const relativePath = file.webkitRelativePath || file.name;
                const dirPath = relativePath.substring(0, relativePath.lastIndexOf('/'));

                if (dirPath) {
                    const parts = dirPath.split('/');
                    let currentPath = '';
                    for (const part of parts) {
                        currentPath = currentPath ? currentPath + '/' + part : part;
                        directories.add(currentPath);
                    }
                }
            });

            const sortedDirs = Array.from(directories).sort();
            const basePath = targetOperationDir || currentDir;

            console.log('Starting folder upload:', filesList.length, 'files,', sortedDirs.length, 'directories to', basePath);

            // Phase 1: Create directories in batch
            updateUploadProgress(0, 100, 'Creating folder structure...');

            try {
                const dirFormData = new FormData();
                dirFormData.append('action', 'createDirsBatch');
                dirFormData.append('basePath', basePath);
                dirFormData.append('dirs', JSON.stringify(sortedDirs));

                const dirResponse = await fetch(window.location.href, {
                    method: 'POST',
                    body: dirFormData
                });
                const dirResult = await dirResponse.json();
                console.log('Directory creation result:', dirResult);

                if (!dirResult.success) {
                    throw new Error(dirResult.error || 'Failed to create directories');
                }

                updateUploadProgress(5, 100, 'Directories created, uploading files...');

                // Phase 2: Upload all files with higher concurrency
                const totalFiles = filesList.length;
                let uploadedCount = 0;
                let failedFiles = [];

                // Use a higher concurrency limiter for folder uploads (6 concurrent)
                const folderUploadLimiter = new RequestLimiter(6);

                // Queue all files at once - the limiter handles concurrency
                const uploadPromises = filesList.map(file => {
                    return folderUploadLimiter.execute(async () => {
                        const formData = new FormData();
                        formData.append('action', 'uploadFileOnly');
                        formData.append('file', file);
                        formData.append('basePath', basePath);
                        formData.append('relativePath', file.webkitRelativePath || file.name);

                        try {
                            const response = await fetch(window.location.href, {
                                method: 'POST',
                                body: formData
                            });
                            const data = await response.json();

                            uploadedCount++;
                            const percent = 5 + Math.round((uploadedCount / totalFiles) * 95);
                            updateUploadProgress(percent, 100, `Uploading: ${file.name} (${uploadedCount}/${totalFiles})`);

                            if (!data.success) {
                                failedFiles.push(file.webkitRelativePath || file.name);
                            }
                            return data;
                        } catch (err) {
                            uploadedCount++;
                            failedFiles.push(file.webkitRelativePath || file.name);
                            console.error('Upload failed for:', file.name, err);
                            return { success: false };
                        }
                    });
                });

                await Promise.all(uploadPromises);

                // Complete
                updateUploadProgress(100, 100, `Uploaded ${uploadedCount - failedFiles.length} files`);

                if (failedFiles.length > 0) {
                    console.warn('Failed files:', failedFiles);
                    alert(`Upload complete. ${failedFiles.length} files failed.`);
                }

                setTimeout(() => {
                    closeModal('uploadModal');
                    refreshList();
                    resetUploadModal();
                }, 1000);

            } catch (error) {
                console.error('Upload error:', error);
                alert('Upload failed: ' + error.message);
                resetUploadModal();
            }
        }

        function uploadAndExtract() {
            const zipInput = document.getElementById('zipInput');
            const extractPath = document.getElementById('extractPath').value;

            if (!zipInput.files.length) {
                alert('Please select an archive file to upload');
                return;
            }

            const file = zipInput.files[0];
            const fileSize = file.size;
            const fileName = file.name;

            // Check if it's a zip file (for SSE progress support)
            const isZip = fileName.toLowerCase().endsWith('.zip');

            const basePath = targetOperationDir || currentDir;

            showUploadProgress();
            updateUploadProgress(0, 100, 'Starting upload of ' + fileName + '...');

            if (isZip) {
                // Two-step process with SSE progress for zip files
                uploadAndExtractWithProgress(file, basePath, extractPath);
            } else {
                // Fall back to original single-request method for non-zip archives
                uploadAndExtractLegacy(file, basePath, extractPath);
            }
        }

        // New two-step upload with SSE extraction progress
        function uploadAndExtractWithProgress(file, basePath, extractPath) {
            const fileName = file.name;

            const formData = new FormData();
            formData.append('action', 'uploadZipForExtract');
            formData.append('file', file);
            formData.append('basePath', basePath);
            formData.append('extractPath', extractPath);

            // Use XMLHttpRequest for upload progress tracking
            const xhr = new XMLHttpRequest();

            // Track upload progress (0-50% of total progress)
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 50);
                    const mbUploaded = (e.loaded / 1048576).toFixed(2);
                    const mbTotal = (e.total / 1048576).toFixed(2);
                    updateUploadProgress(percentComplete, 100, `Uploading: ${mbUploaded}MB / ${mbTotal}MB`);
                }
            });

            // Handle load event (upload complete)
            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    try {
                        const data = JSON.parse(xhr.responseText);

                        if (data.success) {
                            // Upload complete, now start SSE extraction
                            updateUploadProgress(50, 100, 'Upload complete. Starting extraction...');
                            startExtractionWithSSE(data.tempFile, data.extractPath);
                        } else {
                            alert('Upload failed: ' + (data.error || 'Unknown error'));
                            hideUploadProgress();
                        }
                    } catch (e) {
                        console.error('JSON parse error:', e);
                        alert('Invalid response from server.');
                        hideUploadProgress();
                    }
                } else {
                    alert('Upload failed. Server returned status: ' + xhr.status);
                    hideUploadProgress();
                }
            });

            xhr.addEventListener('error', () => {
                alert('Error during upload. Please check your connection.');
                hideUploadProgress();
            });

            xhr.addEventListener('abort', () => {
                hideUploadProgress();
            });

            xhr.open('POST', window.location.href);
            xhr.send(formData);
        }

        // SSE-based extraction with real-time progress
        function startExtractionWithSSE(tempFile, extractPath) {
            const params = new URLSearchParams({
                tempFile: tempFile,
                extractPath: extractPath
            });

            // Build URL relative to current script location
            const currentPath = window.location.pathname;
            const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
            const sseUrl = basePath + 'extract_progress.php?' + params.toString();

            const eventSource = new EventSource(sseUrl);
            let lastFilename = '';

            eventSource.addEventListener('progress', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    // Map extraction progress to 50-100% of total progress
                    const extractPercent = data.percent || 0;
                    const totalPercent = 50 + Math.round(extractPercent / 2);
                    lastFilename = data.filename || lastFilename;

                    let statusText = `Extracting: ${data.current}/${data.total} files`;
                    if (lastFilename) {
                        statusText += ` - ${lastFilename}`;
                    }
                    updateUploadProgress(totalPercent, 100, statusText);
                } catch (err) {
                    console.error('Error parsing progress:', err);
                }
            });

            eventSource.addEventListener('status', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    updateUploadProgress(50, 100, data.message || 'Processing...');
                } catch (err) {
                    console.error('Error parsing status:', err);
                }
            });

            eventSource.addEventListener('complete', (e) => {
                eventSource.close();
                try {
                    const data = JSON.parse(e.data);
                    updateUploadProgress(100, 100, `Extraction complete! ${data.extractedFiles} files extracted.`);

                    setTimeout(() => {
                        closeModal('uploadModal');
                        refreshList();
                        resetUploadModal();
                    }, 800);
                } catch (err) {
                    console.error('Error parsing complete:', err);
                    hideUploadProgress();
                }
            });

            eventSource.addEventListener('error', (e) => {
                eventSource.close();
                try {
                    // Try to parse error data if available
                    if (e.data) {
                        const data = JSON.parse(e.data);
                        alert('Extraction failed: ' + (data.message || 'Unknown error'));
                    } else {
                        alert('Connection to extraction progress lost. The extraction may still be running.');
                    }
                } catch (err) {
                    alert('Extraction failed. Please try again.');
                }
                hideUploadProgress();
            });

            // Handle EventSource errors
            eventSource.onerror = (e) => {
                if (eventSource.readyState === EventSource.CLOSED) {
                    // Connection was closed normally
                    return;
                }
                eventSource.close();
                alert('Connection to extraction progress lost.');
                hideUploadProgress();
            };
        }

        // Legacy single-request extraction for non-zip files
        function uploadAndExtractLegacy(file, basePath, extractPath) {
            const fileName = file.name;

            const formData = new FormData();
            formData.append('action', 'uploadAndUnzip');
            formData.append('file', file);
            formData.append('basePath', basePath);
            formData.append('extractPath', extractPath);

            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percentComplete = Math.round((e.loaded / e.total) * 100);
                    const mbUploaded = (e.loaded / 1048576).toFixed(2);
                    const mbTotal = (e.total / 1048576).toFixed(2);
                    updateUploadProgress(percentComplete, 100, `Uploading: ${mbUploaded}MB / ${mbTotal}MB`);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    updateUploadProgress(100, 100, 'Upload complete. Extracting archive...');

                    try {
                        const data = JSON.parse(xhr.responseText);
                        updateUploadProgress(100, 100, data.success ? 'Extraction complete!' : 'Processing complete');

                        setTimeout(() => {
                            if (data.success) {
                                closeModal('uploadModal');
                                refreshList();
                                resetUploadModal();
                            } else {
                                alert('Upload and extraction failed: ' + (data.error || 'Unknown error'));
                                hideUploadProgress();
                            }
                        }, 500);
                    } catch (e) {
                        console.error('JSON parse error:', e);
                        alert('Invalid response from server.');
                        hideUploadProgress();
                    }
                } else {
                    alert('Upload failed. Server returned status: ' + xhr.status);
                    hideUploadProgress();
                }
            });

            xhr.addEventListener('error', () => {
                alert('Error during upload. Please check your connection.');
                hideUploadProgress();
            });

            xhr.addEventListener('abort', () => {
                hideUploadProgress();
            });

            xhr.open('POST', window.location.href);
            xhr.send(formData);
        }

        function showUploadProgress() {
            document.getElementById('uploadProgress').style.display = 'block';
        }

        function hideUploadProgress() {
            document.getElementById('uploadProgress').style.display = 'none';
        }

        function updateUploadProgress(completed, total, text) {
            const percent = Math.round((completed / total) * 100);
            document.getElementById('uploadProgressText').textContent = text;
            document.getElementById('uploadProgressPercent').textContent = percent + '%';
            document.getElementById('uploadProgressBar').style.width = percent + '%';
        }

        function resetUploadModal() {
            document.getElementById('fileInput').value = '';
            document.getElementById('folderInput').value = '';
            document.getElementById('zipInput').value = '';
            document.getElementById('extractPath').value = '';
            hideUploadProgress();
        }

        // Create directory
        function createDirectory() {
            const dirName = document.getElementById('dirName').value;

            if (!dirName) {
                alert('Please enter a folder name');
                return;
            }

            // Use targetOperationDir if set, otherwise use currentDir
            const baseDir = targetOperationDir || currentDir;
            const fullPath = baseDir === '/' ? '/' + dirName : baseDir + '/' + dirName;

            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=createDir&name=' + encodeURIComponent(fullPath)
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    closeModal('createDirModal');
                    document.getElementById('dirName').value = '';
                    refreshList();
                } else {
                    alert('Failed to create folder');
                }
            });
        }
        
        // Create file
        function createFile() {
            const fileName = document.getElementById('fileName').value;

            if (!fileName) {
                alert('Please enter a file name');
                return;
            }

            // Validate file name (basic check)
            if (fileName.includes('/') || fileName.includes('\\')) {
                alert('File name cannot contain slashes');
                return;
            }

            // Use targetOperationDir if set, otherwise use currentDir
            const baseDir = targetOperationDir || currentDir;
            const fullPath = baseDir === '/' ? '/' + fileName : baseDir + '/' + fileName;

            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=createFile&name=' + encodeURIComponent(fullPath)
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    closeModal('createFileModal');
                    document.getElementById('fileName').value = '';
                    // Refresh the file list first, then open for editing
                    refreshList();
                    // Small delay to ensure file is available before editing
                    setTimeout(() => {
                        editFile(fileName);
                    }, 500);
                } else {
                    alert('Failed to create file: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(error => {
                alert('Error creating file');
            });
        }

        // Delete selected items
        async function deleteSelected() {
            if (!selectedItems.length) {
                alert('No items selected');
                return;
            }

            if (!confirm('Delete ' + selectedItems.length + ' item(s)?')) {
                return;
            }

            // Use Promise.all with rate limiting for concurrent deletes
            const deletePromises = selectedItems.map(item => {
                return requestLimiter.execute(async () => {
                    // Use fullPath if available (for nested items), otherwise construct from currentDir
                    let itemPath = item.fullPath || (currentDir === '/' ? '/' + item.name : currentDir + '/' + item.name);
                    // Remove leading slashes for FTP
                    itemPath = itemPath.replace(/^\/+/, '');


                    const response = await fetch(window.location.href, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: 'action=delete&path=' + encodeURIComponent(itemPath) + '&type=' + item.type
                    });
                    return response.json();
                });
            });

            try {
                await Promise.all(deletePromises);
                selectedItems = [];
                refreshList();
            } catch (error) {
                console.error('Delete error:', error);
                alert('Some deletions failed. Please try again.');
                refreshList(); // Refresh anyway to see what was actually deleted
            }
        }

        // Delete single item
        async function deleteItem(name, type, event, fullPath = null) {
            event.stopPropagation();

            // Check if this item is part of a selection
            const isPartOfSelection = selectedItems.some(item => item.name === name);
            if (isPartOfSelection && selectedItems.length > 1) {
                // Use deleteSelected instead
                deleteSelected();
                return;
            }

            if (!confirm('Delete ' + name + '?')) {
                return;
            }

            let itemPath = fullPath || (currentDir + '/' + name);
            itemPath = itemPath.replace(/^\/+/, ''); // Remove leading slash for FTP

            try {
                await requestLimiter.execute(async () => {
                    const response = await fetch(window.location.href, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: 'action=delete&path=' + encodeURIComponent(itemPath) + '&type=' + type
                    });
                    const data = await response.json();

                    if (data.success) {
                        refreshList();
                    } else {
                        alert('Failed to delete ' + name);
                    }

                    return data;
                });
            } catch (error) {
                console.error('Delete error:', error);
                alert('Failed to delete ' + name);
            }
        }
        
        // Move single item
        function moveItem(name, type, event, fullPath = null) {
            event.stopPropagation();

            // Check if this item is part of a selection
            const isPartOfSelection = selectedItems.some(item => item.name === name);
            if (isPartOfSelection && selectedItems.length > 1) {
                // Use moveSelected instead
                moveSelected();
                return;
            }

            const itemPath = fullPath || (currentDir + '/' + name);

            // Set up move modal for single item
            document.getElementById('currentMoveDir').textContent = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
            document.getElementById('moveItems').innerHTML = '<div class="move-item">' + (type === 'dir' ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-file"></i>') + ' ' + escapeHtml(name) + '</div>';
            document.getElementById('movePath').value = '';

            // Store the items to move with full path
            window.currentMoveItems = [{name: name, type: type, fullPath: itemPath}];

            // Initialize move modal
            initializeMoveModal();

            showModal('moveModal');
        }
        
        function moveSelected() {
            if (!selectedItems.length) {
                alert('No items selected');
                return;
            }
            
            // Set up move modal for selected items
            document.getElementById('currentMoveDir').textContent = currentDir;
            
            let itemsHtml = '';
            selectedItems.forEach(item => {
                itemsHtml += '<div class="move-item">' + (item.type === 'dir' ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-file"></i>') + ' ' + escapeHtml(item.name) + '</div>';
            });
            document.getElementById('moveItems').innerHTML = itemsHtml;
            document.getElementById('movePath').value = '';
            
            // Store the items to move
            window.currentMoveItems = selectedItems.slice(); // Copy array
            
            // Initialize move modal
            initializeMoveModal();
            
            showModal('moveModal');
        }
        
        
        // Initialize move modal
        function initializeMoveModal() {
            // Reset to folder picker mode
            toggleFolderPicker();
            
            // Initialize current move directory - start from current directory
            window.currentMoveDir = currentDir || '/';
            window.selectedMovePath = currentDir || '/';
            
            // Load folders from current directory
            loadMoveFolders(currentDir || '/');
            
            // Update selected path display
            document.getElementById('selectedMovePath').textContent = currentDir || '/';
        }
        
        // Toggle between folder picker and manual path
        function toggleFolderPicker() {
            document.getElementById('folderPickerSection').style.display = 'block';
            document.getElementById('manualPathSection').style.display = 'none';
            document.getElementById('folderPickerToggle').classList.add('btn-primary');
            document.getElementById('folderPickerToggle').classList.remove('btn-light');
            document.getElementById('manualPathToggle').classList.add('btn-light');
            document.getElementById('manualPathToggle').classList.remove('btn-primary');
        }
        
        function toggleManualPath() {
            document.getElementById('folderPickerSection').style.display = 'none';
            document.getElementById('manualPathSection').style.display = 'block';
            document.getElementById('manualPathToggle').classList.add('btn-primary');
            document.getElementById('manualPathToggle').classList.remove('btn-light');
            document.getElementById('folderPickerToggle').classList.add('btn-light');
            document.getElementById('folderPickerToggle').classList.remove('btn-primary');
        }
        
        // Load folders for move destination
        async function loadMoveFolders(path) {
            const folderPicker = document.getElementById('folderPicker');
            folderPicker.innerHTML = '<div class="folder-picker-loading">\ud83d\udd04 Loading folders...</div>';
            
            try {
                const response = await fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=list&dir=' + encodeURIComponent(path)
                });
                
                const data = await response.json();
                
                if (data.success) {
                    const folders = data.items.filter(item => item.type === 'dir' && item.name !== '..');
                    
                    let html = '';
                    
                    // Add parent directory option if not at root
                    if (path !== '/') {
                        const parentPath = path.split('/').slice(0, -1).join('/') || '/';
                        html += '<div class="folder-picker-item" data-action="navigate" data-path="' + escapeHtml(parentPath) + '">';
                        html += '\ud83d\udd19 .. (Parent Directory)';
                        html += '</div>';
                    }
                    
                    // Add current directory selection option
                    html += '<div class="folder-picker-item current-folder" data-action="select" data-path="' + escapeHtml(path) + '">';
                    html += '\u2705 \ud83d\udcc1 Move files here (' + (path === '/' ? 'Root' : escapeHtml(path.split('/').pop())) + ')';
                    html += '</div>';
                    
                    // Add subdirectories
                    folders.forEach(folder => {
                        const folderPath = path === '/' ? '/' + folder.name : path + '/' + folder.name;
                        html += '<div class="folder-picker-item" data-action="navigate" data-path="' + escapeHtml(folderPath) + '">';
                        html += '\ud83d\udcc1 ' + escapeHtml(folder.name);
                        html += '</div>';
                    });
                    
                    if (folders.length === 0 && path === '/') {
                        html += '<div class="folder-picker-loading">No folders found</div>';
                    }
                    
                    folderPicker.innerHTML = html;
                    
                    // Add click event listeners to folder picker items
                    folderPicker.querySelectorAll('.folder-picker-item').forEach(item => {
                        item.addEventListener('click', function(event) {
                            const action = this.getAttribute('data-action');
                            const itemPath = this.getAttribute('data-path');
                            
                            
                            if (action === 'select') {
                                selectMoveDestination(itemPath, this);
                            } else if (action === 'navigate') {
                                navigateMoveTo(itemPath);
                            }
                        });
                    });
                } else {
                    folderPicker.innerHTML = '<div class="folder-picker-loading">\u274c Error loading folders</div>';
                }
            } catch (error) {
                folderPicker.innerHTML = '<div class="folder-picker-loading">\u274c Error loading folders</div>';
            }
        }
        
        // Navigate to a folder in move picker
        function navigateMoveTo(path) {
            window.currentMoveDir = path;
            // Also auto-select this folder as destination
            window.selectedMovePath = path;
            document.getElementById('selectedMovePath').textContent = path;
            
            loadMoveFolders(path);
            updateMoveBreadcrumb(path);
        }
        
        // Select move destination
        function selectMoveDestination(path, clickedElement) {
            window.selectedMovePath = path;
            document.getElementById('selectedMovePath').textContent = path;
            
            // Highlight selected folder
            document.querySelectorAll('.folder-picker-item').forEach(item => {
                item.classList.remove('selected');
            });
            
            // Highlight the clicked item
            if (clickedElement) {
                clickedElement.classList.add('selected');
            }
        }
        
        // Update breadcrumb for move navigation
        function updateMoveBreadcrumb(path) {
            const breadcrumb = document.getElementById('moveBreadcrumb');
            const parts = path.split('/').filter(p => p);
            
            let html = '<span class="breadcrumb-link" data-path="/">';
            html += '\ud83c\udfe0 Root</span>';
            
            let currentPath = '';
            parts.forEach(part => {
                currentPath += '/' + part;
                html += ' / <span class="breadcrumb-link" data-path="' + escapeHtml(currentPath) + '">';
                html += escapeHtml(part) + '</span>';
            });
            
            breadcrumb.innerHTML = html;
            
            // Add click event listeners to breadcrumb links
            breadcrumb.querySelectorAll('.breadcrumb-link').forEach(link => {
                link.addEventListener('click', function() {
                    const linkPath = this.getAttribute('data-path');
                    navigateMoveTo(linkPath);
                });
            });
        }
        
        // Perform the move operation
        function performMove() {
            let destinationPath;
            
            // Check which mode is active
            if (document.getElementById('folderPickerSection').style.display !== 'none') {
                // Folder picker mode
                destinationPath = window.selectedMovePath || '/';
            } else {
                // Manual path mode
                destinationPath = document.getElementById('movePath').value.trim();
                if (!destinationPath) {
                    alert('Please enter a destination path');
                    return;
                }
            }
            
            if (!window.currentMoveItems || window.currentMoveItems.length === 0) {
                alert('No items to move');
                return;
            }
            
            showLoader();
            
            // Move items sequentially
            let successCount = 0;
            let errorCount = 0;
            let currentIndex = 0;
            
            function moveNextItem() {
                if (currentIndex >= window.currentMoveItems.length) {
                    // All items processed
                    hideLoader();
                    
                    if (successCount > 0) {
                        closeModal('moveModal');
                        selectedItems = []; // Clear selection
                        refreshList();
                        
                        // Only show alert if there were errors
                        if (errorCount > 0) {
                            alert('Moved ' + successCount + ' items successfully, ' + errorCount + ' failed');
                        }
                        // No alert for successful moves - just close modal and refresh
                    } else {
                        alert('Failed to move any items');
                    }
                    return;
                }
                
                const item = window.currentMoveItems[currentIndex];
                let oldPath = item.fullPath || (currentDir + '/' + item.name);
                let newPath = destinationPath + '/' + item.name;

                // Remove leading slashes for FTP paths
                oldPath = oldPath.replace(/^\/+/, '');
                newPath = newPath.replace(/^\/+/, '');

                fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=move&oldPath=' + encodeURIComponent(oldPath) +
                          '&newPath=' + encodeURIComponent(newPath) +
                          '&type=' + item.type
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        successCount++;
                    } else {
                        errorCount++;
                        console.error('Failed to move', item.name, ':', data.error);
                    }
                    currentIndex++;
                    moveNextItem(); // Process next item
                })
                .catch(error => {
                    errorCount++;
                    console.error('Move error for', item.name, ':', error);
                    currentIndex++;
                    moveNextItem(); // Process next item
                });
            }
            
            // Start moving items
            moveNextItem();
        }

        // Copy functions
        function copyItem(name, type, event, fullPath = null) {
            event.stopPropagation();

            // Check if this item is part of a selection
            const isPartOfSelection = selectedItems.some(item => item.name === name);
            if (isPartOfSelection && selectedItems.length > 1) {
                // Use copySelected instead
                copySelected();
                return;
            }

            const itemPath = fullPath || (currentDir + '/' + name);

            // Set up copy modal for single item
            document.getElementById('currentCopyDir').textContent = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
            document.getElementById('copyItems').innerHTML = '<div class="move-item">' + (type === 'dir' ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-file"></i>') + ' ' + escapeHtml(name) + '</div>';
            document.getElementById('copyPath').value = '';

            // Store the items to copy with full path
            window.currentCopyItems = [{name: name, type: type, fullPath: itemPath}];

            // Show filename input for single file, hide for directories
            if (type === 'file') {
                document.getElementById('copyFilenameSection').style.display = 'block';
                document.getElementById('copyOriginalFilename').textContent = name;
                document.getElementById('copyNewFilename').value = name;
            } else {
                document.getElementById('copyFilenameSection').style.display = 'none';
                document.getElementById('copyNewFilename').value = '';
            }

            // Initialize copy modal
            initializeCopyModal();

            showModal('copyModal');
        }

        function copySelected() {
            if (!selectedItems.length) {
                alert('No items selected');
                return;
            }

            // Set up copy modal for selected items
            document.getElementById('currentCopyDir').textContent = currentDir;

            let itemsHtml = '';
            selectedItems.forEach(item => {
                itemsHtml += '<div class="move-item">' + (item.type === 'dir' ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-file"></i>') + ' ' + escapeHtml(item.name) + '</div>';
            });
            document.getElementById('copyItems').innerHTML = itemsHtml;
            document.getElementById('copyPath').value = '';

            // Store the items to copy
            window.currentCopyItems = selectedItems.slice(); // Copy array

            // Show filename input only for single file
            if (selectedItems.length === 1 && selectedItems[0].type === 'file') {
                document.getElementById('copyFilenameSection').style.display = 'block';
                document.getElementById('copyOriginalFilename').textContent = selectedItems[0].name;
                document.getElementById('copyNewFilename').value = selectedItems[0].name;
            } else {
                document.getElementById('copyFilenameSection').style.display = 'none';
                document.getElementById('copyNewFilename').value = '';
            }

            // Initialize copy modal
            initializeCopyModal();

            showModal('copyModal');
        }

        // Initialize copy modal
        function initializeCopyModal() {
            // Reset to folder picker mode
            toggleCopyFolderPicker();

            // Initialize current copy directory - start from current directory
            window.currentCopyDir = currentDir || '/';
            window.selectedCopyPath = currentDir || '/';

            // Load folders from current directory
            loadCopyFolders(currentDir || '/');

            // Update selected path display
            document.getElementById('selectedCopyPath').textContent = currentDir || '/';
        }

        // Toggle between folder picker and manual path for copy
        function toggleCopyFolderPicker() {
            document.getElementById('copyFolderPickerSection').style.display = 'block';
            document.getElementById('copyManualPathSection').style.display = 'none';
            document.getElementById('copyFolderPickerToggle').classList.add('btn-primary');
            document.getElementById('copyFolderPickerToggle').classList.remove('btn-light');
            document.getElementById('copyManualPathToggle').classList.add('btn-light');
            document.getElementById('copyManualPathToggle').classList.remove('btn-primary');
        }

        function toggleCopyManualPath() {
            document.getElementById('copyFolderPickerSection').style.display = 'none';
            document.getElementById('copyManualPathSection').style.display = 'block';
            document.getElementById('copyManualPathToggle').classList.add('btn-primary');
            document.getElementById('copyManualPathToggle').classList.remove('btn-light');
            document.getElementById('copyFolderPickerToggle').classList.add('btn-light');
            document.getElementById('copyFolderPickerToggle').classList.remove('btn-primary');
        }

        // Load folders for copy modal
        function loadCopyFolders(path) {
            const folderPicker = document.getElementById('copyFolderPicker');
            folderPicker.innerHTML = '<div class="folder-picker-loading"><i class="fas fa-spinner fa-spin"></i> Loading folders...</div>';

            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=list&dir=' + encodeURIComponent(path)
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    let html = '';

                    // Get parent path
                    const pathParts = path.split('/').filter(p => p);
                    const parentPath = pathParts.length > 0 ? '/' + pathParts.slice(0, -1).join('/') : '/';

                    // Add parent directory option if not at root
                    if (path !== '/' && path !== '') {
                        html += '<div class="folder-picker-item" data-action="navigate" data-path="' + escapeHtml(parentPath) + '">';
                        html += '<i class="fas fa-level-up-alt"></i> <strong>..</strong> (Parent Directory)';
                        html += '</div>';
                    }

                    // Add current directory selection
                    html += '<div class="folder-picker-item current-folder" data-action="select" data-path="' + escapeHtml(path) + '">';
                    html += '<i class="fas fa-folder"></i> <strong>.</strong> (Current Directory)';
                    html += '</div>';

                    // Add subfolders
                    data.items.forEach(item => {
                        if (item.type === 'dir') {
                            const folderPath = path + '/' + item.name;
                            html += '<div class="folder-picker-item" data-action="navigate" data-path="' + escapeHtml(folderPath) + '">';
                            html += '<i class="fas fa-folder"></i> ' + escapeHtml(item.name);
                            html += '</div>';
                        }
                    });

                    folderPicker.innerHTML = html;

                    // Add click handlers
                    document.querySelectorAll('#copyFolderPicker .folder-picker-item').forEach(item => {
                        item.addEventListener('click', function() {
                            const action = this.getAttribute('data-action');
                            const itemPath = this.getAttribute('data-path');

                            // Remove previous selection
                            document.querySelectorAll('#copyFolderPicker .folder-picker-item').forEach(i => i.classList.remove('selected'));

                            if (action === 'select') {
                                this.classList.add('selected');
                                window.selectedCopyPath = itemPath;
                                document.getElementById('selectedCopyPath').textContent = itemPath;
                            } else if (action === 'navigate') {
                                navigateCopyTo(itemPath);
                            }
                        });
                    });

                    // Update breadcrumb
                    updateCopyBreadcrumb(path);
                } else {
                    folderPicker.innerHTML = '<div class="folder-picker-error">Failed to load folders</div>';
                }
            })
            .catch(error => {
                console.error('Error loading copy folders:', error);
                folderPicker.innerHTML = '<div class="folder-picker-error">Error loading folders</div>';
            });
        }

        function navigateCopyTo(path) {
            window.currentCopyDir = path;
            window.selectedCopyPath = path;
            document.getElementById('selectedCopyPath').textContent = path;
            loadCopyFolders(path);
        }

        function updateCopyBreadcrumb(path) {
            const breadcrumb = document.getElementById('copyBreadcrumb');
            let html = '<span class="breadcrumb-link" onclick="navigateCopyTo(\'/\')"><i class="fas fa-home"></i> Root</span>';

            if (path !== '/' && path !== '') {
                const parts = path.split('/').filter(p => p);
                let currentPath = '';

                parts.forEach(part => {
                    currentPath += '/' + part;
                    html += ' <span class="breadcrumb-separator">/</span> ';
                    html += '<span class="breadcrumb-link" onclick="navigateCopyTo(\'' + escapeHtml(currentPath) + '\')">' + escapeHtml(part) + '</span>';
                });
            }

            breadcrumb.innerHTML = html;
        }

        function performCopy() {
            let destinationPath;

            // Check which mode is active
            if (document.getElementById('copyFolderPickerSection').style.display !== 'none') {
                // Folder picker mode
                destinationPath = window.selectedCopyPath || '/';
            } else {
                // Manual path mode
                destinationPath = document.getElementById('copyPath').value.trim();
                if (!destinationPath) {
                    alert('Please enter a destination path');
                    return;
                }
            }

            if (!window.currentCopyItems || window.currentCopyItems.length === 0) {
                alert('No items to copy');
                return;
            }

            showLoader();

            // Copy items sequentially
            let successCount = 0;
            let errorCount = 0;
            let currentIndex = 0;

            function copyNextItem() {
                if (currentIndex >= window.currentCopyItems.length) {
                    // All items processed
                    hideLoader();

                    if (successCount > 0) {
                        closeModal('copyModal');
                        selectedItems = []; // Clear selection
                        refreshList();

                        // Only show alert if there were errors
                        if (errorCount > 0) {
                            alert('Copied ' + successCount + ' items successfully, ' + errorCount + ' failed');
                        }
                        // No alert for successful copies - just close modal and refresh
                    } else {
                        alert('Failed to copy any items');
                    }
                    return;
                }

                const item = window.currentCopyItems[currentIndex];
                let oldPath = item.fullPath || (currentDir + '/' + item.name);

                // Use custom filename if provided for single file copy
                let targetFilename = item.name;
                if (window.currentCopyItems.length === 1 && item.type === 'file') {
                    const customFilename = document.getElementById('copyNewFilename').value.trim();
                    if (customFilename && customFilename !== '') {
                        targetFilename = customFilename;
                    }
                }
                let newPath = destinationPath + '/' + targetFilename;

                // Remove leading slashes for FTP paths
                oldPath = oldPath.replace(/^\/+/, '');
                newPath = newPath.replace(/^\/+/, '');

                fetch(window.location.href, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'action=copy&oldPath=' + encodeURIComponent(oldPath) +
                          '&newPath=' + encodeURIComponent(newPath) +
                          '&type=' + item.type
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        successCount++;
                    } else {
                        errorCount++;
                    }
                    currentIndex++;
                    copyNextItem(); // Process next item
                })
                .catch(error => {
                    errorCount++;
                    currentIndex++;
                    copyNextItem(); // Process next item
                });
            }

            // Start copying items
            copyNextItem();
        }

        // Download file
        function downloadFile(name, event, fullPath = null) {
            event.stopPropagation();

            // Check if this item is part of a selection
            const isPartOfSelection = selectedItems.some(item => item.name === name);
            if (isPartOfSelection && selectedItems.length > 1) {
                // Use downloadSelected instead
                downloadSelected();
                return;
            }

            const form = document.createElement('form');
            form.method = 'POST';
            form.action = window.location.href;

            const actionInput = document.createElement('input');
            actionInput.type = 'hidden';
            actionInput.name = 'action';
            actionInput.value = 'download';

            const fileInput = document.createElement('input');
            fileInput.type = 'hidden';
            fileInput.name = 'file';
            const filePath = fullPath || (currentDir + '/' + name);
            fileInput.value = filePath.replace(/^\/+/, ''); // Remove leading slash for FTP

            form.appendChild(actionInput);
            form.appendChild(fileInput);
            document.body.appendChild(form);
            form.submit();
            document.body.removeChild(form);
        }

        // Download selected
        function downloadSelected() {
            if (!selectedItems.length) {
                alert('No items selected');
                return;
            }
            
            if (selectedItems.length === 1 && selectedItems[0].type === 'file') {
                // Single file - use direct download
                downloadFile(selectedItems[0].name, new Event('click'));
            } else {
                // Multiple items or folder - create zip
                downloadAsZip(selectedItems);
            }
        }

        // Download items as zip
        function downloadAsZip(items) {
            // If single item, use its name as default, otherwise use 'download.zip'
            let defaultName = 'download.zip';
            if (items.length === 1) {
                defaultName = items[0].name + '.zip';
            }

            const zipName = prompt('Enter zip filename:', defaultName);
            if (!zipName) return;

            showLoader();

            // Determine the base path from the selected items
            let basePath = currentDir;

            // If items have fullPath, extract the directory from the first item
            if (items.length > 0 && items[0].fullPath) {
                const fullPath = items[0].fullPath;
                // Extract directory by removing the filename
                basePath = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/';
            } else if (items.length > 0 && items[0].parentPath) {
                // Fallback to parentPath if fullPath not available
                basePath = items[0].parentPath;
            }

            // Remove leading slashes for FTP compatibility
            basePath = basePath.replace(/^\/+/, '');

            const form = document.createElement('form');
            form.method = 'POST';
            form.action = window.location.href;

            const actionInput = document.createElement('input');
            actionInput.type = 'hidden';
            actionInput.name = 'action';
            actionInput.value = 'downloadZip';

            const itemsInput = document.createElement('input');
            itemsInput.type = 'hidden';
            itemsInput.name = 'items';
            itemsInput.value = JSON.stringify(items);

            const basePathInput = document.createElement('input');
            basePathInput.type = 'hidden';
            basePathInput.name = 'basePath';
            basePathInput.value = basePath;
            
            const zipNameInput = document.createElement('input');
            zipNameInput.type = 'hidden';
            zipNameInput.name = 'zipName';
            zipNameInput.value = zipName;
            
            form.appendChild(actionInput);
            form.appendChild(itemsInput);
            form.appendChild(basePathInput);
            form.appendChild(zipNameInput);
            
            document.body.appendChild(form);
            form.submit();
            document.body.removeChild(form);
            
            // Hide loader after a short delay (download should start)
            setTimeout(() => hideLoader(), 2000);
        }

        // Download folder as zip
        function downloadFolder(folderName, event, fullPath = null) {
            event.stopPropagation();

            // Check if this item is part of a selection
            const isPartOfSelection = selectedItems.some(item => item.name === folderName);
            if (isPartOfSelection && selectedItems.length > 1) {
                // Use downloadSelected instead
                downloadSelected();
                return;
            }

            const itemPath = fullPath || (currentDir + '/' + folderName);
            let basePath = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
            basePath = basePath.replace(/^\/+/, ''); // Remove leading slash for FTP

            const items = [{name: folderName, type: 'dir'}];
            const defaultName = folderName + '.zip';
            const zipName = prompt('Enter zip filename:', defaultName);

            if (!zipName) return;

            showLoader();

            const form = document.createElement('form');
            form.method = 'POST';
            form.action = window.location.href;

            const actionInput = document.createElement('input');
            actionInput.type = 'hidden';
            actionInput.name = 'action';
            actionInput.value = 'downloadZip';

            const itemsInput = document.createElement('input');
            itemsInput.type = 'hidden';
            itemsInput.name = 'items';
            itemsInput.value = JSON.stringify(items);

            const basePathInput = document.createElement('input');
            basePathInput.type = 'hidden';
            basePathInput.name = 'basePath';
            basePathInput.value = basePath;

            const zipNameInput = document.createElement('input');
            zipNameInput.type = 'hidden';
            zipNameInput.name = 'zipName';
            zipNameInput.value = zipName;

            form.appendChild(actionInput);
            form.appendChild(itemsInput);
            form.appendChild(basePathInput);
            form.appendChild(zipNameInput);

            document.body.appendChild(form);
            form.submit();
            document.body.removeChild(form);

            // Hide loader after a short delay (download should start)
            setTimeout(() => hideLoader(), 2000);
        }

        // Rename item
        function renameItem(name, event, fullPath = null) {
            event.stopPropagation();

            let itemPath = fullPath || (currentDir === '/' ? '/' + name : currentDir + '/' + name);
            const itemDir = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';

            const newName = prompt('New name:', name);
            if (!newName || newName === name) {
                return;
            }

            let newPath = itemDir === '/' ? '/' + newName : itemDir + '/' + newName;

            // Remove leading slashes for FTP paths
            itemPath = itemPath.replace(/^\/+/, '');
            newPath = newPath.replace(/^\/+/, '');

            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=rename&oldPath=' + encodeURIComponent(itemPath) +
                      '&newPath=' + encodeURIComponent(newPath)
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    refreshList();
                } else {
                    alert('Failed to rename');
                }
            });
        }

        // Edit file functionality
        let currentEditPath = '';
        let isWysiwygMode = false;
        let showingPreview = false;

        function editSelected() {
            if (selectedItems.length !== 1 || selectedItems[0].type !== 'file') {
                alert('Please select a single file to edit');
                return;
            }
            
            editFile(selectedItems[0].name);
        }

        function editFile(filename, fullPath = null) {
            if (!isFileEditable(filename)) {
                alert('This file type cannot be edited. Only text-based files can be edited.');
                return;
            }

            // Use provided path or construct from current directory
            let normalizedPath = fullPath || (currentDir === '/' ? '/' + filename : currentDir + '/' + filename);

            // Remove leading slash for FTP paths (FTP expects relative paths)
            normalizedPath = normalizedPath.replace(/^\/+/, '');

            currentEditPath = normalizedPath;

            document.getElementById('editFileName').textContent = filename;
            
            // Get file type for display
            const fileType = getFileTypeDisplay(filename);
            document.getElementById('fileType').textContent = '(' + fileType + ')';
            
            // Show WYSIWYG button for HTML files
            const ext = getFileExtension(filename).toLowerCase();
            const wysiwygBtn = document.getElementById('wysiwygBtn');
            const previewBtn = document.getElementById('previewBtn');
            
            if (ext === 'html' || ext === 'htm') {
                wysiwygBtn.style.display = 'block';
                previewBtn.style.display = 'block';
            } else {
                wysiwygBtn.style.display = 'none';
                previewBtn.style.display = 'none';
            }
            
            // Reset preview state when opening a new file
            showingPreview = false;
            const previewContainer = document.getElementById('previewContainer');
            if (previewContainer) {
                previewContainer.style.display = 'none';
            }

            // Reset WYSIWYG state when opening a new file
            isWysiwygMode = false;

            // Destroy TinyMCE instance if it exists
            if (tinyMCEInstance) {
                tinymce.remove('#wysiwygEditor');
                tinyMCEInstance = null;
            }

            const wysiwygContainer = document.getElementById('wysiwygContainer');
            const editorContainer = document.getElementById('editorContainer');
            if (wysiwygContainer) {
                wysiwygContainer.style.display = 'none';
            }
            if (editorContainer) {
                editorContainer.style.display = 'block';
            }

            // Reset WYSIWYG button text
            const wysiwygBtnElement = document.getElementById('wysiwygBtn');
            if (wysiwygBtnElement) {
                wysiwygBtnElement.innerHTML = '<i class="fas fa-eye"></i> WYSIWYG';
            }

            showLoader();

            const requestBody = 'action=edit&path=' + encodeURIComponent(currentEditPath);

            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: requestBody
            })
            .then(response => {
                return response.text();
            })
            .then(responseText => {
                try {
                    const data = JSON.parse(responseText);
                    hideLoader();
                    if (data.success) {
                        // Handle base64 encoded content if necessary
                        let content = data.content;
                        if (data.encoded === true) {
                            content = atob(content); // Decode base64
                        }
                        // Initialize CodeMirror if not already done
                        if (!codeMirrorEditor) {
                            initializeCodeMirror();
                        }
                        
                        // Set content and mode
                        codeMirrorEditor.setValue(content);
                        originalEditorContent = content; // Store original for change detection

                        // Optimize settings based on file size and type
                        optimizeForFileSize(content.length, filename);

                        setCodeMirrorMode(filename);
                        // Enable linting for supported file types
                        enableLintingForFileType(filename);
                        
                        showModal('editorModal');
                        
                        // Refresh CodeMirror after modal is shown
                        setTimeout(() => {
                            codeMirrorEditor.refresh();
                            codeMirrorEditor.focus();
                        }, 100);
                        
                        updateEditorStatus();
                    } else {
                        console.error('Edit failed:', data.error);
                        alert('Failed to load file: ' + (data.error || 'Unknown error'));
                    }
                } catch (e) {
                    console.error('JSON parse error:', e);
                    console.error('Response was not valid JSON:', responseText);
                    alert('Invalid response from server. Check console for details.');
                    hideLoader();
                }
            })
            .catch(error => {
                console.error('Edit request error:', error);
                hideLoader();
                alert('Error loading file');
            });
        }

        function isFileEditable(filename) {
            const editableExtensions = [
                'php', 'html', 'htm', 'css', 'js', 'txt', 'md', 'json', 'xml', 'sql', 
                'py', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'go', 'ts', 'tsx', 'jsx', 
                'vue', 'yaml', 'yml', 'ini', 'conf', 'sh', 'bash', 'log', 'csv'
            ];
            
            // Special cases for files without extensions or starting with dot
            const specialFiles = [
                '.htaccess', '.htpasswd', '.gitignore', '.env', '.config',
                'dockerfile', 'makefile', 'readme', 'license', 'changelog'
            ];
            
            const ext = getFileExtension(filename).toLowerCase();
            const lowerFilename = filename.toLowerCase();
            
            // Check if it's a special file (like .htaccess)
            if (specialFiles.some(special => lowerFilename === special || lowerFilename.endsWith(special))) {
                return true;
            }
            
            // Check by extension
            return editableExtensions.includes(ext);
        }

        function getFileTypeDisplay(filename) {
            const ext = getFileExtension(filename).toLowerCase();
            const lowerFilename = filename.toLowerCase();
            
            // Special files
            if (lowerFilename === '.htaccess') return 'Apache Config';
            if (lowerFilename === '.htpasswd') return 'Apache Password';
            if (lowerFilename === '.gitignore') return 'Git Ignore';
            if (lowerFilename === '.env') return 'Environment';
            if (lowerFilename === 'dockerfile') return 'Docker';
            if (lowerFilename === 'makefile') return 'Makefile';
            if (lowerFilename === 'readme' || lowerFilename.startsWith('readme.')) return 'README';
            if (lowerFilename === 'license' || lowerFilename.startsWith('license.')) return 'License';
            if (lowerFilename === 'changelog' || lowerFilename.startsWith('changelog.')) return 'Changelog';
            
            // File extensions
            const types = {
                'php': 'PHP', 'html': 'HTML', 'htm': 'HTML', 'css': 'CSS', 'js': 'JavaScript',
                'ts': 'TypeScript', 'tsx': 'TypeScript JSX', 'jsx': 'JavaScript JSX',
                'py': 'Python', 'java': 'Java', 'c': 'C', 'cpp': 'C++', 'h': 'C Header',
                'cs': 'C#', 'rb': 'Ruby', 'go': 'Go', 'vue': 'Vue.js',
                'json': 'JSON', 'xml': 'XML', 'yaml': 'YAML', 'yml': 'YAML',
                'sql': 'SQL', 'md': 'Markdown', 'txt': 'Text', 'log': 'Log',
                'ini': 'INI Config', 'conf': 'Config', 'config': 'Config',
                'sh': 'Shell Script', 'bash': 'Bash Script', 'csv': 'CSV'
            };
            
            return types[ext] || ext.toUpperCase() || 'Text';
        }

        function saveFile(shouldClose = true) {
            let content;
            if (isWysiwygMode && tinyMCEInstance) {
                // Get content from TinyMCE - use format: 'html' to get full HTML with fullpage plugin
                content = tinyMCEInstance.getContent({ format: 'html' });
            } else {
                // Get content from code editor
                content = codeMirrorEditor ? codeMirrorEditor.getValue() : document.getElementById('codeEditor').value;
            }

            showLoader();
            
            fetch(window.location.href, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=save&path=' + encodeURIComponent(currentEditPath) + '&content=' + encodeURIComponent(content)
            })
            .then(response => response.json())
            .then(data => {
                hideLoader();
                if (data.success) {
                    // Update original content to current (no longer has unsaved changes)
                    originalEditorContent = content;
                    updateEditorStatus('Saved successfully');
                    if (shouldClose) {
                        setTimeout(() => {
                            closeModal('editorModal');
                            updateEditorStatus('Ready');
                        }, 500);
                    } else {
                        setTimeout(() => updateEditorStatus('Ready'), 2000);
                    }
                } else {
                    alert('Failed to save file');
                }
            })
            .catch(error => {
                hideLoader();
                alert('Error saving file');
            });
        }

        let tinyMCEInstance = null;

        function toggleWysiwyg() {
            const codeContainer = document.getElementById('editorContainer');
            const wysiwygContainer = document.getElementById('wysiwygContainer');
            const codeEditor = document.getElementById('codeEditor');

            if (isWysiwygMode) {
                // Switch to code mode - get content from TinyMCE and destroy it
                if (tinyMCEInstance) {
                    const htmlContent = tinyMCEInstance.getContent({ format: 'html' });
                    tinymce.remove('#wysiwygEditor');
                    tinyMCEInstance = null;

                    if (codeMirrorEditor) {
                        codeMirrorEditor.setValue(htmlContent);
                    } else {
                        codeEditor.value = htmlContent;
                    }
                }

                codeContainer.style.display = 'block';
                wysiwygContainer.style.display = 'none';
                isWysiwygMode = false;
                document.getElementById('wysiwygBtn').innerHTML = '<i class="fas fa-eye"></i> WYSIWYG';

                // Refresh CodeMirror after showing
                if (codeMirrorEditor) {
                    setTimeout(() => codeMirrorEditor.refresh(), 100);
                }
            } else {
                // Switch to WYSIWYG mode - initialize TinyMCE
                const codeContent = codeMirrorEditor ? codeMirrorEditor.getValue() : codeEditor.value;

                codeContainer.style.display = 'none';
                wysiwygContainer.style.display = 'block';
                isWysiwygMode = true;
                document.getElementById('wysiwygBtn').innerHTML = '<i class="fas fa-code"></i> Code';

                // Initialize TinyMCE 5 with comprehensive options including fullpage
                tinymce.init({
                    selector: '#wysiwygEditor',
                    height: '100%',
                    menubar: 'file edit view insert format tools table help',
                    menu: {
                        file: { title: 'File', items: 'newdocument restoredraft | preview | print | save' },
                        edit: { title: 'Edit', items: 'undo redo | cut copy paste pastetext | selectall | searchreplace' },
                        view: { title: 'View', items: 'code visualaid visualblocks visualchars | spellchecker | preview fullscreen' },
                        insert: { title: 'Insert', items: 'image link media template codesample inserttable | charmap emoticons hr | pagebreak nonbreaking anchor toc | insertdatetime' },
                        format: { title: 'Format', items: 'bold italic underline strikethrough superscript subscript codeformat | formats blockformats fontformats fontsizes align lineheight | forecolor backcolor | language | removeformat' },
                        tools: { title: 'Tools', items: 'fullpage | spellchecker | a11ycheck | code wordcount' },
                        table: { title: 'Table', items: 'inserttable | cell row column | advtablerownumbering | tableprops deletetable' },
                        help: { title: 'Help', items: 'help' }
                    },
                    plugins: [
                        'advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'preview',
                        'anchor', 'searchreplace', 'visualblocks', 'visualchars', 'code', 'fullscreen', 'fullpage',
                        'insertdatetime', 'media', 'table', 'help', 'wordcount',
                        'codesample', 'emoticons', 'template', 'pagebreak', 'nonbreaking',
                        'directionality', 'save', 'hr', 'imagetools', 'quickbars',
                        'autosave', 'importcss', 'print', 'paste', 'autoresize',
                        'noneditable', 'tabfocus', 'textpattern', 'toc'
                    ],
                    toolbar: 'undo redo | blocks | ' +
                        'bold italic underline strikethrough | forecolor backcolor | ' +
                        'fontfamily fontsize | alignleft aligncenter ' +
                        'alignright alignjustify | bullist numlist outdent indent | ' +
                        'link image media table codesample | emoticons charmap hr pagebreak | ' +
                        'template toc | ltr rtl | nonbreaking anchor | removeformat | visualchars visualblocks | code fullscreen help',
                    content_style: 'body { font-family:Helvetica,Arial,sans-serif; font-size:14px }',
                    font_family_formats: 'Arial=arial,helvetica,sans-serif; Courier New=courier new,courier,monospace; Georgia=georgia,serif; Times New Roman=times new roman,times,serif; Verdana=verdana,geneva,sans-serif',
                    font_size_formats: '8pt 10pt 12pt 14pt 18pt 24pt 36pt',
                    block_formats: 'Paragraph=p; Header 1=h1; Header 2=h2; Header 3=h3; Header 4=h4; Header 5=h5; Header 6=h6; Preformatted=pre',
                    fullpage_default_doctype: '<!DOCTYPE html>',
                    fullpage_hide_in_source_view: false,
                    extended_valid_elements: '*[*]',
                    valid_elements: '*[*]',
                    verify_html: false,
                    cleanup: false,
                    convert_urls: false,
                    remove_linebreaks: false,
                    entity_encoding: 'raw',
                    // Paste plugin options
                    paste_data_images: true,
                    paste_as_text: false,
                    paste_preprocess: function(plugin, args) {
                        // Allow all pasted content
                    },
                    paste_word_valid_elements: '*[*]',
                    paste_retain_style_properties: 'all',
                    paste_merge_formats: true,
                    // Autosave options
                    autosave_interval: '30s',
                    autosave_retention: '30m',
                    autosave_restore_when_empty: true,
                    // Autoresize options
                    autoresize_bottom_margin: 50,
                    min_height: 400,
                    max_height: 1000,
                    // Textpattern options (auto-formatting as you type)
                    textpattern_patterns: [
                        {start: '*', end: '*', format: 'italic'},
                        {start: '**', end: '**', format: 'bold'},
                        {start: '#', format: 'h1'},
                        {start: '##', format: 'h2'},
                        {start: '###', format: 'h3'},
                        {start: '####', format: 'h4'},
                        {start: '#####', format: 'h5'},
                        {start: '######', format: 'h6'},
                        {start: '1. ', cmd: 'InsertOrderedList'},
                        {start: '* ', cmd: 'InsertUnorderedList'},
                        {start: '- ', cmd: 'InsertUnorderedList'}
                    ],
                    // TOC options
                    toc_depth: 3,
                    toc_header: 'h2',
                    toc_class: 'table-of-contents',
                    // Image tools options
                    imagetools_toolbar: 'rotateleft rotateright | flipv fliph | editimage imageoptions',
                    // Quickbars
                    quickbars_selection_toolbar: 'bold italic | quicklink h2 h3 blockquote | bullist numlist',
                    quickbars_insert_toolbar: 'quickimage quicktable | hr pagebreak',
                    // Context menu
                    contextmenu: 'link image table | spellchecker | inserttable cell row column deletetable',
                    // Save plugin callback
                    save_onsavecallback: function() {
                        saveFile(false); // Save but don't close
                    },
                    save_enablewhendirty: true,
                    setup: function(editor) {
                        editor.on('init', function() {
                            editor.setContent(codeContent);
                        });
                        tinyMCEInstance = editor;
                    }
                });
            }
        }

        function togglePreview() {
            const previewContainer = document.getElementById('previewContainer');
            const previewFrame = document.getElementById('previewFrame');
            
            if (!previewContainer || !previewFrame) {
                console.error('Preview elements not found');
                return;
            }
            
            if (showingPreview) {
                previewContainer.style.display = 'none';
                showingPreview = false;
            } else {
                let content;
                if (isWysiwygMode && tinyMCEInstance) {
                    content = tinyMCEInstance.getContent({ format: 'html' });
                } else {
                    content = codeMirrorEditor ? codeMirrorEditor.getValue() : document.getElementById('codeEditor').value;
                }

                previewFrame.srcdoc = content;
                previewContainer.style.display = 'block';
                showingPreview = true;
            }
        }

        function formatCode() {
            const ext = getFileExtension(currentEditPath).toLowerCase();
            
            if (ext === 'json') {
                try {
                    const currentContent = codeMirrorEditor ? codeMirrorEditor.getValue() : document.getElementById('codeEditor').value;
                    const formatted = JSON.stringify(JSON.parse(currentContent), null, 2);
                    
                    if (codeMirrorEditor) {
                        codeMirrorEditor.setValue(formatted);
                    } else {
                        document.getElementById('codeEditor').value = formatted;
                    }
                    
                    updateEditorStatus('JSON formatted');
                } catch (e) {
                    alert('Invalid JSON format');
                }
            } else {
                // Basic formatting for other types
                updateEditorStatus('Basic formatting applied');
            }
            
            setTimeout(() => updateEditorStatus('Ready'), 2000);
        }

        function updateEditorStatus(message = 'Ready') {
            document.getElementById('editorStatus').textContent = message;
        }
        
        // CodeMirror instance
        let codeMirrorEditor = null;

        // Track original content for unsaved changes detection
        let originalEditorContent = '';

        // Normalize content for comparison (handle line ending differences)
        function normalizeContent(str) {
            // Convert all line endings to \n and trim trailing whitespace
            return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }

        // Check if editor has unsaved changes
        function hasUnsavedChanges() {
            if (!codeMirrorEditor) return false;
            const currentContent = codeMirrorEditor.getValue();
            // Normalize both to handle line ending differences
            return normalizeContent(currentContent) !== normalizeContent(originalEditorContent);
        }

        // Close editor with unsaved changes check
        function closeEditorWithCheck() {
            if (hasUnsavedChanges()) {
                if (confirm('You have unsaved changes. Are you sure you want to close without saving?')) {
                    closeModal('editorModal');
                }
            } else {
                closeModal('editorModal');
            }
        }
        
        // Track if we're in large file mode (performance optimizations)
        let isLargeFile = false;
        const LARGE_FILE_THRESHOLD = 25000; // 25KB

        // Optimize CodeMirror settings based on file size and type
        function optimizeForFileSize(fileSize, filename = '') {
            if (!codeMirrorEditor) return;

            // Get file extension
            const ext = filename.split('.').pop().toLowerCase();
            const isPlainText = (ext === 'txt' || ext === 'log' || ext === 'csv');

            isLargeFile = fileSize > LARGE_FILE_THRESHOLD || isPlainText;

            if (isLargeFile) {
                // Disable expensive features for large files
                codeMirrorEditor.setOption('styleActiveLine', false);
                codeMirrorEditor.setOption('matchBrackets', false);
                codeMirrorEditor.setOption('autoCloseBrackets', false);
                codeMirrorEditor.setOption('highlightSelectionMatches', false);
                codeMirrorEditor.setOption('styleSelectedText', false);
                codeMirrorEditor.setOption('lineWrapping', false);

                if (isPlainText) {
                    console.log('Plain text file - performance mode enabled');
                    updateEditorStatus('Plain text - performance mode');
                } else {
                    console.log('Large file detected (' + Math.round(fileSize/1024) + 'KB) - performance mode enabled');
                    updateEditorStatus('Large file - performance mode');
                }
            } else {
                // Enable all features for normal files
                codeMirrorEditor.setOption('styleActiveLine', true);
                codeMirrorEditor.setOption('matchBrackets', true);
                codeMirrorEditor.setOption('autoCloseBrackets', true);
                codeMirrorEditor.setOption('lineWrapping', true);
                codeMirrorEditor.setOption('highlightSelectionMatches', {
                    minChars: 2,
                    trim: true,
                    style: 'matchhighlight',
                    showToken: /\w|\$/,
                    annotateScrollbar: false
                });
                codeMirrorEditor.setOption('styleSelectedText', true);
            }
        }

        // Initialize CodeMirror editor (fallback to v5)
        function initializeCodeMirror() {
            if (codeMirrorEditor) {
                return; // Already initialized
            }

            try {
                const textarea = document.getElementById('codeEditor');
                codeMirrorEditor = CodeMirror.fromTextArea(textarea, {
                    lineNumbers: true,
                    lineWrapping: false, // Disable for better performance, enable only for small files
                    autoCloseBrackets: true,
                    matchBrackets: true,
                    styleActiveLine: true,
                    indentUnit: 4,
                    tabSize: 4,
                    mode: 'text/plain',
                    // Performance: limit viewport rendering
                    viewportMargin: 50,
                    // Performance: limit max highlight length
                    maxHighlightLength: 10000,
                    // Enable auto-completion
                    hintOptions: {
                        completeSingle: false,
                        alignWithWord: true,
                        closeOnUnfocus: true
                    },
                    // Enable match highlighting for selected text (will be disabled for large files)
                    highlightSelectionMatches: {
                        minChars: 2,
                        trim: true,
                        style: 'matchhighlight',
                        showToken: /\w|\$/,
                        annotateScrollbar: false // Disabled - causes lag on large files
                    },
                    // Enable selection marking
                    styleSelectedText: true,
                    extraKeys: {
                        'Esc': function(cm) {
                            closeEditorWithCheck();
                        },
                        'Ctrl-S': function(cm) {
                            saveFile(false);
                        },
                        'Cmd-S': function(cm) {
                            saveFile(false);
                        },
                        'Ctrl-F': 'findPersistent',
                        'Cmd-F': 'findPersistent',
                        'Ctrl-H': 'replace',
                        'Cmd-Alt-F': 'replace',
                        // Auto-completion shortcuts
                        'Ctrl-Space': function(cm) {
                            console.log('Manual hint trigger (Ctrl-Space)');
                            cm.showHint();
                        },
                        'Alt-Space': function(cm) {
                            console.log('Manual hint trigger (Alt-Space)');
                            cm.showHint();
                        },
                        // Auto-trigger on typing for certain characters
                        '.': function(cm) {
                            cm.replaceSelection('.');
                            setTimeout(() => cm.showHint(), 100);
                            return true;
                        },
                        '$': function(cm) {
                            cm.replaceSelection('$');
                            setTimeout(() => cm.showHint(), 100);
                            return true;
                        }
                    }
                });

                // Set up auto-completion behavior
                codeMirrorEditor.on('inputRead', function(cm, change) {
                    // Skip auto-completion for large files (performance)
                    if (isLargeFile) return;

                    if (change.origin === '+input') {
                        const text = change.text[0];
                        const cursor = cm.getCursor();
                        const line = cm.getLine(cursor.line);

                        // Get text before cursor
                        const beforeCursor = line.slice(0, cursor.ch);

                        // Check for word or $ pattern at end of line
                        const wordMatch = beforeCursor.match(/[$\w]+$/);
                        const currentWord = wordMatch ? wordMatch[0] : '';

                        // Check if we just typed $
                        const justTypedDollar = text === '$' || beforeCursor.endsWith('$');

                        const currentMode = cm.getOption('mode');
                        const isPhpMode = (typeof currentMode === 'object' && currentMode.name === 'php') ||
                                        (typeof currentMode === 'string' && currentMode === 'php');

                        console.log('Input:', text, 'Current word:', currentWord, 'Just typed $:', justTypedDollar);

                        // Auto-trigger hints
                        let shouldTrigger = false;

                        // Always trigger for $ in PHP mode
                        if (justTypedDollar && isPhpMode) {
                            console.log('Triggering PHP hints for $ character');
                            shouldTrigger = true;
                        }
                        // Trigger for PHP variables being typed
                        else if (currentWord.startsWith('$') && currentWord.length >= 2 && isPhpMode) {
                            console.log('Triggering hints for PHP variable:', currentWord);
                            shouldTrigger = true;
                        }
                        // Trigger for regular words
                        else if (currentWord.length >= 2 && !currentWord.startsWith('$')) {
                            console.log('Triggering hints for word:', currentWord);
                            shouldTrigger = true;
                        }

                        if (shouldTrigger) {
                            setTimeout(() => {
                                if (!cm.state.completionActive) {
                                    console.log('Showing hints...');
                                    cm.showHint();
                                }
                            }, 100);
                        }
                    }
                });

                // Set initial theme
                updateCodeMirrorTheme();

                // Auto-resize to fit container
                codeMirrorEditor.setSize('100%', '100%');

                console.log('CodeMirror editor initialized successfully (using v5 fallback with auto-completion)');
                return true;
            } catch (error) {
                console.error('Failed to initialize CodeMirror:', error);
                // Fallback: show the original textarea
                document.getElementById('codeEditor').style.display = 'block';
                return false;
            }
        }
        
        // Update CodeMirror theme to match file manager theme
        function updateCodeMirrorTheme(forcedTheme) {
            if (!codeMirrorEditor) return;

            const isDarkTheme = document.body.getAttribute('data-theme') === 'dark';
            const theme = forcedTheme || (isDarkTheme ? 'darcula' : 'default');

            codeMirrorEditor.setOption('theme', theme);
            console.log('CodeMirror theme set to:', theme);
        }
        
        // Get file mode for syntax highlighting
        function getCodeMirrorMode(filename) {
            const ext = getFileExtension(filename).toLowerCase();

            const modeMap = {
                'js': 'javascript',
                'jsx': 'javascript',
                'ts': 'javascript',
                'tsx': 'javascript',
                'json': {name: 'javascript', json: true},
                'css': 'css',
                'scss': 'text/x-scss',
                'sass': 'text/x-sass',
                'less': 'text/x-less',
                'html': 'htmlmixed',
                'htm': 'htmlmixed',
                'xml': 'xml',
                'svg': 'xml',
                'php': {name: 'php', startOpen: true},
                'py': 'python',
                'md': 'markdown',
                'markdown': 'markdown',
                'sql': 'sql',
                'sh': 'shell',
                'bash': 'shell',
                'yml': 'yaml',
                'yaml': 'yaml',
                'c': 'text/x-csrc',
                'cpp': 'text/x-c++src',
                'java': 'text/x-java',
                'txt': 'text/plain',
                'log': 'text/plain'
            };

            return modeMap[ext] || 'text/plain';
        }
        
        // Enable linting based on file type for CodeMirror 6
        function enableLintingForFileType(filename) {
            if (!codeMirrorEditor) return;

            const ext = filename.split('.').pop().toLowerCase();
            let lintEnabled = false;

            // Note: CodeMirror 6 linting requires different approach
            // For now, we'll disable linting and could add it back with proper CM6 lint extensions
            console.log('Linting configuration for extension:', ext);

            switch(ext) {
                case 'js':
                case 'jsx':
                    if (typeof JSHINT !== 'undefined') {
                        console.log('JSHINT available for JavaScript linting');
                        // TODO: Implement CodeMirror 6 linting with JSHINT
                        lintEnabled = false; // Disabled for now
                    }
                    break;
                case 'json':
                    if (typeof jsonlint !== 'undefined') {
                        console.log('JSONLint available for JSON linting');
                        // TODO: Implement CodeMirror 6 linting with JSONLint
                        lintEnabled = false; // Disabled for now
                    }
                    break;
                case 'css':
                case 'scss':
                case 'less':
                    if (typeof CSSLint !== 'undefined') {
                        console.log('CSSLint available for CSS linting');
                        // TODO: Implement CodeMirror 6 linting with CSSLint
                        lintEnabled = false; // Disabled for now
                    }
                    break;
                case 'html':
                case 'htm':
                    console.log('HTML linting not configured');
                    break;
                case 'php':
                    console.log('PHP syntax highlighting enabled (no linting)');
                    // Add basic client-side PHP syntax helpers
                    setupPHPSyntaxHelpers();
                    break;
                default:
                    console.log('No special linting for extension:', ext);
                    break;
            }

            if (lintEnabled) {
                updateEditorStatus('Linting enabled');
                setTimeout(() => updateEditorStatus('Ready'), 1000);
            } else {
                updateEditorStatus('Ready');
            }
        }
        
        function setupPHPSyntaxHelpers() {
            if (!codeMirrorEditor) return;

            // Basic client-side PHP syntax helpers for CodeMirror 6
            // Note: Full PHP syntax helpers would require more complex implementation
            // For now, we'll keep it simple since CM6 handles most basic editing features

            console.log('PHP syntax helpers initialized (simplified for CodeMirror 6)');

            // CodeMirror 6 handles most bracket matching automatically through basicSetup
            // Custom PHP-specific helpers could be added here if needed
        }
        
        
        // Set CodeMirror mode based on file type
        function setCodeMirrorMode(filename, forcedMode) {
            if (!codeMirrorEditor) return;

            try {
                const mode = forcedMode || getCodeMirrorMode(filename);
                const ext = getFileExtension(filename).toLowerCase();

                // Set the language mode
                if (typeof mode === 'string' && mode !== 'text/plain') {
                    codeMirrorEditor.setOption('mode', mode);
                    console.log('CodeMirror mode set to:', mode, 'for file:', filename);
                } else if (typeof mode === 'object') {
                    codeMirrorEditor.setOption('mode', mode);
                    console.log('CodeMirror mode set to:', mode, 'for file:', filename);
                } else {
                    codeMirrorEditor.setOption('mode', 'text/plain');
                    console.log('Using text/plain mode for:', filename);
                }

                // Set appropriate hint provider based on file type
                let hintFunction = CodeMirror.hint.anyword; // default

                if (ext === 'php') {
                    hintFunction = CodeMirror.hint.php;
                    console.log('Setting PHP hint function');
                } else if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
                    hintFunction = CodeMirror.hint['javascript-enhanced'];
                } else if (['html', 'htm'].includes(ext)) {
                    hintFunction = CodeMirror.hint.html;
                } else if (['css', 'scss', 'sass', 'less'].includes(ext)) {
                    hintFunction = CodeMirror.hint.css;
                } else if (ext === 'sql') {
                    hintFunction = CodeMirror.hint.sql;
                }

                // Update hint options with the correct function
                codeMirrorEditor.setOption('hintOptions', {
                    completeSingle: false,
                    alignWithWord: true,
                    closeOnUnfocus: true,
                    hint: hintFunction || CodeMirror.hint.anyword
                });

                console.log('Auto-completion provider set for extension:', ext, 'function available:', !!hintFunction);

            } catch (error) {
                console.error('Error setting CodeMirror mode:', error);
                codeMirrorEditor.setOption('mode', 'text/plain');
            }
        }

        // Zip/Unzip functionality
        function zipSelected() {
            if (selectedItems.length === 0) {
                alert('Please select items to zip');
                return;
            }
            
            const zipName = prompt('Enter zip file name:', 'archive_' + Date.now() + '.zip');
            if (!zipName) return;
            
            showLoader();
            
            const paths = selectedItems.map(item => currentDir + '/' + item.name);
            
            fetch('zip_handler.php', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=zip&paths=' + encodeURIComponent(JSON.stringify(paths)) + 
                      '&zipName=' + encodeURIComponent(zipName) + 
                      '&basePath=' + encodeURIComponent(currentDir)
            })
            .then(response => response.json())
            .then(data => {
                hideLoader();
                if (data.success) {
                    alert('Archive created successfully');
                    refreshList();
                    selectedItems = [];
                } else {
                    alert('Failed to create archive: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(error => {
                hideLoader();
                alert('Error creating archive');
            });
        }

        function unzipSelected() {
            if (selectedItems.length !== 1 || !selectedItems[0].name.match(/\.(zip|rar|7z|tar|gz)$/i)) {
                alert('Please select a single archive file to extract');
                return;
            }
            
            const destination = prompt('Extract to directory (leave empty for current directory):');
            
            showLoader();
            
            const zipPath = currentDir + '/' + selectedItems[0].name;
            const extractPath = destination ? currentDir + '/' + destination : currentDir;
            
            fetch('zip_handler.php', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'action=unzip&zipPath=' + encodeURIComponent(zipPath) + 
                      '&extractPath=' + encodeURIComponent(extractPath)
            })
            .then(response => response.json())
            .then(data => {
                hideLoader();
                if (data.success) {
                    alert('Archive extracted successfully');
                    refreshList();
                    selectedItems = [];
                } else {
                    alert('Failed to extract archive: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(error => {
                hideLoader();
                alert('Error extracting archive');
            });
        }
        
        console.log('JavaScript file parsing completed successfully - all functions loaded');

        // ========================================
        // ACCESSIBILITY FEATURES
        // ========================================

        // Live region announcements for screen readers
        function announceToScreenReader(message, assertive = false) {
            const regionId = assertive ? 'alertRegion' : 'liveRegion';
            const region = document.getElementById(regionId);
            if (region) {
                // Clear and set to ensure announcement is read
                region.textContent = '';
                setTimeout(() => {
                    region.textContent = message;
                }, 50);
            }
        }

        // Keyboard navigation state
        let focusedFileIndex = -1;
        let lastFocusedElement = null;

        // Get all focusable file items
        function getFileItems() {
            const fileList = document.getElementById('fileList');
            return Array.from(fileList.querySelectorAll('.file-list-item, .file-grid-item'));
        }

        // Set focus on a file item
        function focusFileItem(index) {
            const items = getFileItems();
            if (index < 0 || index >= items.length) return;

            // Remove previous focus indicator
            items.forEach(item => item.classList.remove('keyboard-focus'));

            // Set new focus
            focusedFileIndex = index;
            const item = items[index];
            item.classList.add('keyboard-focus');
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

            // Announce to screen reader
            const name = item.dataset.name || '';
            const type = item.dataset.type === 'dir' ? 'folder' : 'file';
            announceToScreenReader(`${name}, ${type}`);
        }

        // Clear focus from file items
        function clearFileFocus() {
            const items = getFileItems();
            items.forEach(item => item.classList.remove('keyboard-focus'));
            focusedFileIndex = -1;
        }

        // Initialize keyboard navigation for file list
        function initFileListKeyboardNavigation() {
            const fileList = document.getElementById('fileList');
            if (!fileList) return;

            fileList.addEventListener('keydown', handleFileListKeydown);
            fileList.addEventListener('focus', () => {
                if (focusedFileIndex < 0) {
                    const items = getFileItems();
                    if (items.length > 0) {
                        focusFileItem(0);
                    }
                }
            });
            fileList.addEventListener('blur', () => {
                // Keep focus indicator but don't reset on blur
            });

            // Document-level arrow key handler to refocus file list
            document.addEventListener('keydown', (e) => {
                // Only handle arrow keys
                if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    return;
                }

                // Skip if focus is in an input, textarea, select, or contenteditable
                const activeEl = document.activeElement;
                if (activeEl && (
                    activeEl.tagName === 'INPUT' ||
                    activeEl.tagName === 'TEXTAREA' ||
                    activeEl.tagName === 'SELECT' ||
                    activeEl.isContentEditable ||
                    activeEl.closest('.context-menu') ||
                    activeEl.closest('.modal.active')
                )) {
                    return;
                }

                // Skip if a modal is open
                const activeModal = document.querySelector('.modal.active');
                if (activeModal) {
                    return;
                }

                // If fileList doesn't have focus, refocus it and handle the key
                if (document.activeElement !== fileList) {
                    e.preventDefault();
                    fileList.focus();
                    // If we have a previously focused item, navigation will continue from there
                    // Otherwise the focus handler will select the first item
                    if (focusedFileIndex >= 0) {
                        handleFileListKeydown(e);
                    }
                }
            });
        }

        // Handle keyboard navigation in file list
        function handleFileListKeydown(e) {
            const items = getFileItems();
            if (items.length === 0) return;

            const columns = viewMode === 'grid' ? Math.floor(document.getElementById('fileList').offsetWidth / 160) : 1;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (viewMode === 'grid') {
                        focusFileItem(Math.min(focusedFileIndex + columns, items.length - 1));
                    } else {
                        focusFileItem(Math.min(focusedFileIndex + 1, items.length - 1));
                    }
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    if (viewMode === 'grid') {
                        focusFileItem(Math.max(focusedFileIndex - columns, 0));
                    } else {
                        focusFileItem(Math.max(focusedFileIndex - 1, 0));
                    }
                    break;

                case 'ArrowRight':
                    e.preventDefault();
                    if (focusedFileIndex >= 0 && focusedFileIndex < items.length) {
                        const item = items[focusedFileIndex];
                        if (item.dataset.type === 'dir' && item.dataset.name !== '..') {
                            const expandIcon = item.querySelector('.folder-expand-icon');
                            const folderPath = item.dataset.fullPath || (currentDir === '/' ? '/' + item.dataset.name : currentDir + '/' + item.dataset.name);
                            const isExpanded = expandedFolders.get(folderPath);
                            if (!isExpanded && expandIcon) {
                                toggleFolderExpansion(item, item.dataset.name, expandIcon);
                                break;
                            }
                        }
                    }
                    if (viewMode === 'grid') {
                        focusFileItem(Math.min(focusedFileIndex + 1, items.length - 1));
                    }
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    if (focusedFileIndex >= 0 && focusedFileIndex < items.length) {
                        const item = items[focusedFileIndex];
                        if (item.dataset.type === 'dir' && item.dataset.name !== '..') {
                            const expandIcon = item.querySelector('.folder-expand-icon');
                            const folderPath = item.dataset.fullPath || (currentDir === '/' ? '/' + item.dataset.name : currentDir + '/' + item.dataset.name);
                            const isExpanded = expandedFolders.get(folderPath);
                            if (isExpanded && expandIcon) {
                                toggleFolderExpansion(item, item.dataset.name, expandIcon);
                                break;
                            }
                        }
                    }
                    if (viewMode === 'grid') {
                        focusFileItem(Math.max(focusedFileIndex - 1, 0));
                    }
                    break;

                case 'Home':
                    e.preventDefault();
                    focusFileItem(0);
                    break;

                case 'End':
                    e.preventDefault();
                    focusFileItem(items.length - 1);
                    break;

                case ' ': // Space - toggle selection
                    e.preventDefault();
                    if (focusedFileIndex >= 0 && focusedFileIndex < items.length) {
                        const item = items[focusedFileIndex];
                        const checkbox = item.querySelector('input[type="checkbox"]');
                        if (checkbox) {
                            checkbox.checked = !checkbox.checked;
                            toggleSelection(checkbox, e);
                        }
                    }
                    break;

                case 'Enter': // Enter - open folder or edit file
                    e.preventDefault();
                    if (focusedFileIndex >= 0 && focusedFileIndex < items.length) {
                        const item = items[focusedFileIndex];
                        const name = item.dataset.name;
                        const type = item.dataset.type;
                        const fullPath = item.dataset.fullPath;

                        if (type === 'dir') {
                            if (name === '..') {
                                const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                                navigateTo(parentDir);
                            } else {
                                const folderPath = fullPath || (currentDir === '/' ? '/' + name : currentDir + '/' + name);
                                navigateTo(folderPath);
                            }
                        } else {
                            editFile(name, fullPath);
                        }
                    }
                    break;

                case 'Delete': // Delete key - delete selected
                    e.preventDefault();
                    if (selectedItems.length > 0) {
                        deleteSelected();
                    } else if (focusedFileIndex >= 0) {
                        const item = items[focusedFileIndex];
                        if (item.dataset.name !== '..') {
                            deleteItem(item.dataset.name, item.dataset.type, e, item.dataset.fullPath);
                        }
                    }
                    break;

                case 'F2': // F2 - rename
                    e.preventDefault();
                    if (focusedFileIndex >= 0) {
                        const item = items[focusedFileIndex];
                        if (item.dataset.name !== '..') {
                            renameItem(item.dataset.name, e, item.dataset.fullPath);
                        }
                    }
                    break;

                case 'ContextMenu':
                case 'F10':
                    if (e.key === 'F10' && !e.shiftKey) break;
                    e.preventDefault();
                    if (focusedFileIndex >= 0) {
                        const item = items[focusedFileIndex];
                        const rect = item.getBoundingClientRect();
                        const fakeEvent = {
                            preventDefault: () => {},
                            stopPropagation: () => {},
                            pageX: rect.left + rect.width / 2,
                            pageY: rect.top + rect.height / 2
                        };
                        showContextMenu(fakeEvent, item.dataset.name, item.dataset.type, item.dataset.fullPath);
                        // Focus first menu item
                        setTimeout(() => {
                            const firstMenuItem = document.querySelector('#contextMenu .context-menu-item');
                            if (firstMenuItem) firstMenuItem.focus();
                        }, 50);
                    }
                    break;

                case 'Backspace': // Go to parent directory
                    e.preventDefault();
                    if (currentDir !== '/') {
                        const parentDir = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
                        navigateTo(parentDir);
                    }
                    break;
            }
        }

        // Context menu keyboard navigation
        function initContextMenuKeyboardNavigation() {
            const contextMenu = document.getElementById('contextMenu');
            if (!contextMenu) return;

            contextMenu.addEventListener('keydown', (e) => {
                const menuItems = Array.from(contextMenu.querySelectorAll('.context-menu-item:not([style*="display: none"])'));
                const currentIndex = menuItems.findIndex(item => item === document.activeElement);

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        const nextIndex = (currentIndex + 1) % menuItems.length;
                        menuItems[nextIndex].focus();
                        break;

                    case 'ArrowUp':
                        e.preventDefault();
                        const prevIndex = currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
                        menuItems[prevIndex].focus();
                        break;

                    case 'Home':
                        e.preventDefault();
                        menuItems[0].focus();
                        break;

                    case 'End':
                        e.preventDefault();
                        menuItems[menuItems.length - 1].focus();
                        break;

                    case 'Enter':
                    case ' ':
                        e.preventDefault();
                        if (document.activeElement && document.activeElement.classList.contains('context-menu-item')) {
                            document.activeElement.click();
                        }
                        break;

                    case 'Escape':
                        e.preventDefault();
                        hideContextMenu();
                        // Return focus to file list
                        document.getElementById('fileList').focus();
                        break;

                    case 'Tab':
                        e.preventDefault();
                        hideContextMenu();
                        break;
                }
            });
        }

        // Focus trapping in modals
        function trapFocus(modal) {
            const focusableElements = modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            const firstFocusable = focusableElements[0];
            const lastFocusable = focusableElements[focusableElements.length - 1];

            function handleTabKey(e) {
                if (e.key !== 'Tab') return;

                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable.focus();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable.focus();
                    }
                }
            }

            modal.addEventListener('keydown', handleTabKey);

            // Store handler for cleanup
            modal._focusTrapHandler = handleTabKey;
        }

        function removeFocusTrap(modal) {
            if (modal._focusTrapHandler) {
                modal.removeEventListener('keydown', modal._focusTrapHandler);
                delete modal._focusTrapHandler;
            }
        }

        // Enhanced showModal with focus management
        const originalShowModal = showModal;
        showModal = function(id) {
            lastFocusedElement = document.activeElement;
            originalShowModal(id);

            const modal = document.getElementById(id);
            if (modal) {
                trapFocus(modal);

                // Focus first focusable element
                setTimeout(() => {
                    const firstFocusable = modal.querySelector(
                        'input:not([type="hidden"]), button:not(.btn-light), select, textarea'
                    ) || modal.querySelector('button');
                    if (firstFocusable) {
                        firstFocusable.focus();
                    }
                }, 100);

                // Announce modal opening
                const title = modal.querySelector('.modal-header');
                if (title) {
                    announceToScreenReader(`Dialog opened: ${title.textContent}`);
                }
            }
        };

        // Enhanced closeModal with focus management
        const originalCloseModal = closeModal;
        closeModal = function(id) {
            const modal = document.getElementById(id);
            if (modal) {
                removeFocusTrap(modal);
            }

            originalCloseModal(id);

            // Return focus to previously focused element
            if (lastFocusedElement) {
                setTimeout(() => {
                    lastFocusedElement.focus();
                }, 50);
            }

            announceToScreenReader('Dialog closed');
        };

        // Global keyboard shortcuts
        function initGlobalKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Skip if in input/textarea or modal is open
                const activeTag = document.activeElement.tagName.toLowerCase();
                const isInEditor = document.activeElement.closest('.CodeMirror') !== null;
                const isModalOpen = document.querySelector('.modal.show') !== null;

                if ((activeTag === 'input' || activeTag === 'textarea') && !isInEditor) {
                    // Allow Escape to close modals from inputs
                    if (e.key !== 'Escape') return;
                }

                // Ctrl/Cmd + S for save in editor (this one is safe to override)
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    if (isModalOpen && document.getElementById('editorModal').classList.contains('show')) {
                        e.preventDefault();
                        saveFile(false);
                        announceToScreenReader('File saved');
                    }
                }

                // Shift + key shortcuts (avoids browser conflicts)
                if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    // Only trigger when not typing in inputs
                    if (activeTag === 'input' || activeTag === 'textarea') return;

                    switch (e.key.toUpperCase()) {
                        case 'U': // Upload
                            if (!isModalOpen) {
                                e.preventDefault();
                                showUploadModal();
                                announceToScreenReader('Upload dialog opened');
                            }
                            break;

                        case 'N': // New file
                            if (!isModalOpen) {
                                e.preventDefault();
                                showCreateFileModal();
                                announceToScreenReader('Create file dialog opened');
                            }
                            break;

                        case 'F': // New folder
                            if (!isModalOpen) {
                                e.preventDefault();
                                showCreateDirModal();
                                announceToScreenReader('Create folder dialog opened');
                            }
                            break;

                        case 'D': // Download selected or focused
                            if (!isModalOpen) {
                                e.preventDefault();
                                if (selectedItems.length > 0) {
                                    downloadSelected();
                                    announceToScreenReader('Downloading selected items');
                                } else if (focusedFileIndex >= 0) {
                                    const items = getFileItems();
                                    const item = items[focusedFileIndex];
                                    if (item && item.dataset.name !== '..') {
                                        if (item.dataset.type === 'file') {
                                            downloadFile(item.dataset.name, null, item.dataset.fullPath);
                                        } else {
                                            downloadFolder(item.dataset.name, null, item.dataset.fullPath);
                                        }
                                        announceToScreenReader('Downloading ' + item.dataset.name);
                                    }
                                }
                            }
                            break;

                        case 'C': // Copy selected or focused
                            if (!isModalOpen) {
                                e.preventDefault();
                                if (selectedItems.length > 0) {
                                    copySelected();
                                    announceToScreenReader('Copy dialog opened');
                                } else if (focusedFileIndex >= 0) {
                                    const items = getFileItems();
                                    const item = items[focusedFileIndex];
                                    if (item && item.dataset.name !== '..') {
                                        copyItem(item.dataset.name, item.dataset.type, null, item.dataset.fullPath);
                                        announceToScreenReader('Copy dialog opened');
                                    }
                                }
                            }
                            break;

                        case 'M': // Move selected or focused
                            if (!isModalOpen) {
                                e.preventDefault();
                                if (selectedItems.length > 0) {
                                    moveSelected();
                                    announceToScreenReader('Move dialog opened');
                                } else if (focusedFileIndex >= 0) {
                                    const items = getFileItems();
                                    const item = items[focusedFileIndex];
                                    if (item && item.dataset.name !== '..') {
                                        moveItem(item.dataset.name, item.dataset.type, null, item.dataset.fullPath);
                                        announceToScreenReader('Move dialog opened');
                                    }
                                }
                            }
                            break;

                        case 'R': // Refresh
                            if (!isModalOpen) {
                                e.preventDefault();
                                refreshList();
                                announceToScreenReader('File list refreshed');
                            }
                            break;

                        case 'A': // Toggle select all / deselect all
                            if (!isModalOpen) {
                                e.preventDefault();
                                // Check if all selectable items are selected
                                const selectableItems = allFiles.filter(f => f.name !== '..');
                                if (selectedItems.length >= selectableItems.length && selectableItems.length > 0) {
                                    clearSelection();
                                    announceToScreenReader('All items deselected');
                                } else {
                                    selectAll();
                                    announceToScreenReader('All items selected');
                                }
                            }
                            break;

                        case 'E': // Edit selected or focused file
                            if (!isModalOpen) {
                                e.preventDefault();
                                if (selectedItems.length > 0) {
                                    editSelected();
                                } else if (focusedFileIndex >= 0) {
                                    const items = getFileItems();
                                    const item = items[focusedFileIndex];
                                    if (item && item.dataset.type === 'file') {
                                        editFile(item.dataset.name, item.dataset.fullPath);
                                    }
                                }
                            }
                            break;
                    }
                }

                // Non-modifier shortcuts
                if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                    switch (e.key) {
                        case 'F5': // Refresh
                            if (!isModalOpen) {
                                e.preventDefault();
                                refreshList();
                                announceToScreenReader('File list refreshed');
                            }
                            break;

                        case '/': // Focus search
                            if (!isModalOpen && activeTag !== 'input' && activeTag !== 'textarea') {
                                e.preventDefault();
                                document.getElementById('searchInput').focus();
                                announceToScreenReader('Search field focused');
                            }
                            break;

                        case '?': // Show keyboard shortcuts help
                            if (!isModalOpen && activeTag !== 'input' && activeTag !== 'textarea') {
                                e.preventDefault();
                                showKeyboardShortcutsHelp();
                            }
                            break;
                    }
                }
            });
        }

        // Show keyboard shortcuts help
        function showKeyboardShortcutsHelp() {
            showModal('shortcutsModal');
            announceToScreenReader('Keyboard shortcuts dialog opened');
        }

        // Update aria-pressed states for view toggle buttons
        function updateViewToggleAria() {
            const gridBtn = document.getElementById('gridViewBtn');
            const listBtn = document.getElementById('listViewBtn');
            if (gridBtn && listBtn) {
                gridBtn.setAttribute('aria-pressed', viewMode === 'grid' ? 'true' : 'false');
                listBtn.setAttribute('aria-pressed', viewMode === 'list' ? 'true' : 'false');
            }
        }

        // Enhance setView to update ARIA states
        const originalSetView = setView;
        setView = function(mode) {
            originalSetView(mode);
            updateViewToggleAria();
            clearFileFocus();
            announceToScreenReader(`Switched to ${mode} view`);
        };

        // Enhance updateStatus to announce changes
        const originalUpdateStatus = updateStatus;
        updateStatus = function() {
            originalUpdateStatus();
            // Don't announce every status update, only significant ones
        };

        // Announce selection changes
        const originalToggleSelection = toggleSelection;
        if (typeof toggleSelection === 'function') {
            window.toggleSelection = function(checkbox, event) {
                originalToggleSelection(checkbox, event);
                setTimeout(() => {
                    const count = selectedItems.length;
                    if (count > 0) {
                        announceToScreenReader(`${count} item${count > 1 ? 's' : ''} selected`);
                    }
                }, 100);
            };
        }

        // Enhance navigateTo to announce directory changes
        const originalNavigateTo = navigateTo;
        navigateTo = function(path) {
            originalNavigateTo(path);
            clearFileFocus();
            const folderName = path === '/' ? 'Home' : path.split('/').pop();
            announceToScreenReader(`Navigated to ${folderName}`);
        };

        // Update mobile menu toggle aria-expanded
        function updateSidebarAriaState() {
            const sidebar = document.getElementById('sidebar');
            const menuToggle = document.querySelector('.mobile-menu-toggle');
            if (sidebar && menuToggle) {
                const isOpen = sidebar.classList.contains('open');
                menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
        }

        // Enhance sidebar functions
        const originalOpenSidebar = openSidebar;
        openSidebar = function() {
            originalOpenSidebar();
            updateSidebarAriaState();
            announceToScreenReader('Navigation menu opened');
        };

        const originalCloseSidebar = closeSidebar;
        closeSidebar = function() {
            originalCloseSidebar();
            updateSidebarAriaState();
        };

        // Initialize all accessibility features
        function initAccessibility() {
            initFileListKeyboardNavigation();
            initContextMenuKeyboardNavigation();
            initGlobalKeyboardShortcuts();
            updateViewToggleAria();

            // Add role and tabindex to file items when they're created
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.addedNodes.length) {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === 1) {
                                if (node.classList && (node.classList.contains('file-list-item') || node.classList.contains('file-grid-item'))) {
                                    node.setAttribute('role', 'row');
                                    node.setAttribute('tabindex', '-1');
                                    const name = node.dataset.name || 'Unknown';
                                    const type = node.dataset.type === 'dir' ? 'folder' : 'file';
                                    node.setAttribute('aria-label', `${name}, ${type}`);
                                }
                            }
                        });
                    }
                });
            });

            const fileList = document.getElementById('fileList');
            if (fileList) {
                observer.observe(fileList, { childList: true, subtree: true });
            }

            console.log('Accessibility features initialized');
        }

        // Initialize on DOM ready
        document.addEventListener('DOMContentLoaded', initAccessibility);
