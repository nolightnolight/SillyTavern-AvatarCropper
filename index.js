import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 清理旧版本的Base64体积庞大缓存
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;

// 初始化数据结构
if (extension_settings.avatarGalleryBtnVisible === undefined) extension_settings.avatarGalleryBtnVisible = true;
if (extension_settings.clickAvatarToGallery === undefined) extension_settings.clickAvatarToGallery = true;

if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        let filename = parts[parts.length - 1];
        return decodeURIComponent(filename);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

function isUserAvatar(src) {
    if (!src) return false;
    const cleanSrc = decodeURIComponent(src);
    return cleanSrc.includes('User Avatars') || cleanSrc.includes('user/images') || cleanSrc.includes('User%20Avatars');
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getBinding(theme, avatarId) {
    return extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || null;
}

let lastValidAvatarId = null;
setInterval(() => {
    const previewImg = document.getElementById('avatar_load_preview');
    if (previewImg) {
        const src = previewImg.getAttribute('src');
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            lastValidAvatarId = getAvatarIdFromSrc(src);
        }
    }
}, 500);

// ======================== 后端操作 ========================

async function uploadToBackend(base64Data, prefix = "image") {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}_${randomSuffix}`;
    
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', 
        filename: filename
    };
    
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload failed', e);
    }
    return null;
}

async function uploadToBackendExact(base64Data, exactFilename) {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', 
        filename: exactFilename
    };
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload exact failed', e);
    }
    return null;
}

async function deleteFromBackend(path) {
    try {
        const cleanPath = path.split('?')[0];
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: cleanPath })
        });
    } catch (e) {
        console.error('Delete failed', e);
    }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    try {
        const fetchUrl = url.includes('?') ? url : `${url}?t=${Date.now()}`;
        const data = await fetch(fetchUrl);
        if (!data.ok) throw new Error(`Status: ${data.status}`);
        const blob = await data.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Read failed'));
            reader.readAsDataURL(blob); 
        });
    } catch (error) {
        console.error("Url to Base64 failed: ", error);
        throw error; 
    }
}

async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800; 
                let width = img.width;
                let height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== CSS 渲染 & 状态 ========================

function applyAvatarCss() {
    let styleTag = document.getElementById('st-avatar-bindings-style');
    const theme = getCurrentTheme();
    const bindings = extension_settings.avatarThemeBindings?.[theme] || {};
    const crops = extension_settings.avatarThemeCrops?.[theme] || {};
    let cssString = '';
    
    const activeImages = {};
    const allAvatarIds = new Set([...Object.keys(bindings), ...Object.keys(crops)]);

    for (const avatarId of allAvatarIds) {
        if (avatarId === 'thumbnail') continue;
        const baseImageKey = bindings[avatarId] || avatarId;
        let displayPath = baseImageKey;

        if (crops[avatarId] && crops[avatarId][baseImageKey]) {
            displayPath = crops[avatarId][baseImageKey];
        }

        if (displayPath !== avatarId) {
            activeImages[avatarId] = displayPath;
        }
    }
    
    for (const [avatarId, imagePath] of Object.entries(activeImages)) {
        if (!imagePath) continue;
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        
        cssString += `
            .avatar img[src*="${escapedId}"],
            .avatar img[src*="${encodedId}"],
            #avatar_load_preview[src*="${escapedId}"],
            #avatar_load_preview[src*="${encodedId}"],
            .zoomed_avatar img[src*="${escapedId}"],
            .zoomed_avatar img[src*="${encodedId}"] {
                content: url("${imagePath}") !important;
                object-fit: cover !important;
            }
        `;
    }

    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-bindings-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

function updatePluginState() {
    const isBtnVisible = !!extension_settings.avatarGalleryBtnVisible;
    const isClickZoomEnabled = !!extension_settings.clickAvatarToGallery;
    applyAvatarCss();
    
    let btnVisibilityStyle = document.getElementById('st-avatar-btn-visibility');
    if (!btnVisibilityStyle) {
        btnVisibilityStyle = document.createElement('style');
        btnVisibilityStyle.id = 'st-avatar-btn-visibility';
        document.head.appendChild(btnVisibilityStyle);
    }
    
    let css = '';
    if (!isBtnVisible) {
        css += '.st-trigger-zoom-btn { display: none !important; }\n'; 
    }
    if (!isClickZoomEnabled) {
        // 如果关闭了开关②，则不接管点击头像放大事件，使其恢复原版放大
        css += '.mesAvatarWrapper .avatar img { pointer-events: auto !important; }\n';
    } else {
        // 开启开关②，允许我们劫持
        css += '.mesAvatarWrapper .avatar img { pointer-events: auto !important; }\n';
    }
    btnVisibilityStyle.textContent = css;

    document.querySelectorAll('.mes').forEach(injectChatButton);
}

async function deleteImages(pathsToDelete, avatarId, isUser) {
    if (isUser) {
        extension_settings.userGalleryImages = extension_settings.userGalleryImages.filter(p => !pathsToDelete.includes(p));
    } else {
        extension_settings.charGalleryImages[avatarId] = extension_settings.charGalleryImages[avatarId].filter(p => !pathsToDelete.includes(p));
    }

    if (extension_settings.avatarThemeBindings) {
        for (const theme in extension_settings.avatarThemeBindings) {
            const bindings = extension_settings.avatarThemeBindings[theme];
            if (pathsToDelete.includes(bindings[avatarId])) {
                delete bindings[avatarId];
            }
        }
    }
    if (extension_settings.avatarThemeCrops) {
        for (const theme in extension_settings.avatarThemeCrops) {
            if (extension_settings.avatarThemeCrops[theme][avatarId]) {
                for (const deletedPath of pathsToDelete) {
                    if (extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]) {
                        deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]);
                        delete extension_settings.avatarThemeCrops[theme][avatarId][deletedPath];
                    }
                }
            }
        }
    }

    for (const path of pathsToDelete) {
        await deleteFromBackend(path);
    }

    saveSettingsDebounced();
    applyAvatarCss();
}

// ======================== 图库管理弹窗 ========================

async function openGallery(isUser, avatarId, originalSrc, zoomedDiv) {
    if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
    if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
    if (!isUser && !extension_settings.charGalleryImages[avatarId]) extension_settings.charGalleryImages[avatarId] = [];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户图库' : '角色图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${!isUser ? `<div class="menu_button menu_button_icon margin0" id="btn-alt-import" title="导入"><i class="fa-solid fa-file-import"></i></div>
                                 <div class="menu_button menu_button_icon margin0" id="btn-alt-export" title="导出"><i class="fa-solid fa-file-export"></i></div>` : ''}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理图库"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button margin0" id="btn-alt-delete-confirm"><i class="fa-solid fa-trash-can"></i> <span>点击删除</span></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <input type="file" id="input-alt-import" style="display:none;" accept=".json">
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    const currentBinding = getBinding(getCurrentTheme(), avatarId);
    let tempSelectedPath = currentBinding;
    let isDeleteMode = false;
    let itemsToDelete = new Set();
    
    const avatarNamePrefix = avatarId.split('.')[0].replace(/^\d{13,}-/, '');

    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const btnImport = document.getElementById('btn-alt-import');
        const btnExport = document.getElementById('btn-alt-export');
        const inputUpload = document.getElementById('input-alt-upload');
        const inputImport = document.getElementById('input-alt-import');

        function renderGrid() {
            grid.innerHTML = '';
            
            const cleanOriginalSrc = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (!tempSelectedPath ? ' selected' : '');
            origDiv.innerHTML = `<img src="${cleanOriginalSrc}" title="解除绑定 (恢复原图)" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            const images = isUser ? extension_settings.userGalleryImages : extension_settings.charGalleryImages[avatarId];
            if (images) {
                images.forEach((path) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'alt-avatar-item' + (tempSelectedPath === path ? ' selected' : '');
                    if (itemsToDelete.has(path)) itemDiv.classList.add('to-delete');
                    
                    itemDiv.innerHTML = `<img src="${path}">`;
                    itemDiv.onclick = (e) => {
                        if (isDeleteMode) { 
                            e.stopPropagation(); 
                            toggleDeleteMark(path, itemDiv);
                        } else { 
                            selectAvatar(path); 
                        }
                    };
                    grid.appendChild(itemDiv);
                });
            }
        }
        
        function selectAvatar(path) {
            if (isDeleteMode) return;
            tempSelectedPath = path;
            renderGrid();
        }

        function toggleDeleteMark(path, element) {
            if (itemsToDelete.has(path)) {
                itemsToDelete.delete(path);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(path);
                element.classList.add('to-delete');
            }
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                if(btnImport) btnImport.style.display = 'none';
                if(btnExport) btnExport.style.display = 'none';
                btnDeleteConfirm.classList.add('active');
                itemsToDelete.clear();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理图库';
                btnUpload.style.display = 'flex';
                if(btnImport) btnImport.style.display = 'flex';
                if(btnExport) btnExport.style.display = 'flex';
                btnDeleteConfirm.classList.remove('remove');
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？`, POPUP_TYPE.CONFIRM, '', { okButton: '确认', cancelButton: '取消' });
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            if (itemsToDelete.has(tempSelectedPath)) tempSelectedPath = null;
            await deleteImages(Array.from(itemsToDelete), avatarId, isUser);
            btnManage.click(); 
            toastr.success('已删除图片');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            toastr.info(`正在处理 ${files.length} 张图片`);
            let count = 0;
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const path = await uploadToBackend(b64, avatarNamePrefix);
                if (path) {
                    if (isUser) extension_settings.userGalleryImages.push(path);
                    else extension_settings.charGalleryImages[avatarId].push(path);
                    count++;
                }
            }
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success(`已上传 ${count} 张图片`);
        };

        if (btnExport) {
            btnExport.onclick = async () => {
                const images = extension_settings.charGalleryImages[avatarId] || [];
                if (images.length === 0) return toastr.warning('角色图库为空');
                toastr.info('正在导出...');
                const exportData = [];
                for (const path of images) {
                    try { exportData.push(await getBase64FromUrl(path)); } catch(e) {}
                }
                const blob = new Blob([JSON.stringify(exportData)], {type: "application/json"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `替换卡面-${avatarNamePrefix}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };
        }

        if (btnImport) {
            btnImport.onclick = () => inputImport.click();
            inputImport.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        let count = 0;
                        for (const b64 of data) {
                            const path = await uploadToBackend(b64, avatarNamePrefix);
                            if (path) {
                                extension_settings.charGalleryImages[avatarId].push(path);
                                count++;
                            }
                        }
                        saveSettingsDebounced();
                        renderGrid();
                        toastr.success(`已导入 ${count} 张图片`);
                    } catch (err) { toastr.error('导入失败'); }
                    inputImport.value = '';
                };
                reader.readAsText(file);
            };
        }
        renderGrid();
    }, 100);

    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: '选择此图片', cancelButton: '取消' });
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        if (tempSelectedPath !== currentBinding) {
            const theme = getCurrentTheme();
            if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
            if (!extension_settings.avatarThemeBindings[theme]) extension_settings.avatarThemeBindings[theme] = {};
            
            if (tempSelectedPath === null) {
                delete extension_settings.avatarThemeBindings[theme][avatarId];
                toastr.success('已恢复原图');
            } else {
                extension_settings.avatarThemeBindings[theme][avatarId] = tempSelectedPath;
                toastr.success('已绑定图库图片');
            }
            saveSettingsDebounced();
            applyAvatarCss();
            
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    }
}

// ======================== 核心变更：编辑界面 + 无级旋转滑条 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, isUser, zoomedDiv) {
    if (avatarId === 'thumbnail') return toastr.error('无法获取图片');

    const theme = getCurrentTheme();
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    let sourcePath = extension_settings.avatarThemeBindings?.[theme]?.[avatarId];

    if (!sourcePath) {
        sourcePath = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
    } else if (!sourcePath.startsWith('/') && !sourcePath.startsWith('http') && !sourcePath.startsWith('data:')) {
        sourcePath = '/' + sourcePath; 
    }

    let base64Original;
    try {
        base64Original = await getBase64FromUrl(sourcePath);
    } catch (e) {
        toastr.error(`获取数据失败: ${e.message}`);
        return;
    }

    // 呼出原生编辑剪裁弹窗
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    // 核心注入：在原生的编辑框底部渲染长横条滑动无级旋转控制
    setTimeout(() => {
        const popupBody = document.querySelector('#dialogue_popup .inline-drawer-toggle').parentNode;
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        
        if (popupBody && cropperImg && cropperImg.cropper) {
            const cropper = cropperImg.cropper;
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;

            // 创建最底部的长横条无级旋转滑块
            const sliderContainer = document.createElement('div');
            sliderContainer.className = 'st-edit-rotate-container';
            sliderContainer.innerHTML = `
                <i class="fa-solid fa-arrow-rotate-left" style="color: #aaa;"></i>
                <input type="range" class="st-edit-rotate-slider" min="-180" max="180" value="0" step="1">
                <i class="fa-solid fa-arrow-rotate-right" style="color: #aaa;"></i>
                <span class="st-edit-rotate-value">0°</span>
            `;

            const slider = sliderContainer.querySelector('.st-edit-rotate-slider');
            const valueDisplay = sliderContainer.querySelector('.st-edit-rotate-value');

            // 监听长横条滑动实现自由无级旋转
            let lastValue = 0;
            slider.addEventListener('input', (e) => {
                const currentVal = parseInt(e.target.value);
                valueDisplay.textContent = `${currentVal}°`;
                
                // 计算相对旋转角度差量并调用 Cropper 的 rotate
                const relativeDegree = currentVal - lastValue;
                cropper.rotate(relativeDegree);
                lastValue = currentVal;
            });

            // 插入到编辑页面确认按钮的上方
            const actionButtons = document.querySelector('#dialogue_popup_ok');
            if (actionButtons) {
                actionButtons.parentNode.insertBefore(sliderContainer, actionButtons);
            } else {
                popupBody.appendChild(sliderContainer);
            }
        }
    }, 180);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        let cleanSrc = sourcePath.split('?')[0];
        let filenameWithExt = cleanSrc.split('/').pop();
        let baseImageName = decodeURIComponent(filenameWithExt).replace(/\.[^/.]+$/, "");
        
        baseImageName = baseImageName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const safeThemeName = theme.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const exactFilename = `${baseImageName}_${safeThemeName}_1`;

        if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};
        if (!extension_settings.avatarThemeCrops[theme]) extension_settings.avatarThemeCrops[theme] = {};
        if (!extension_settings.avatarThemeCrops[theme][avatarId]) extension_settings.avatarThemeCrops[theme][avatarId] = {};

        if (extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]) {
            await deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]);
        }

        const path = await uploadToBackendExact(croppedImageBase64, exactFilename);
        if (!path) return toastr.error('保存失败');

        const cacheBusterPath = `${path}?t=${Date.now()}`;
        extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = cacheBusterPath;
        
        saveSettingsDebounced();
        applyAvatarCss(); 
        toastr.success('编辑并旋转成功，已应用修改！');

        const closeBtn = zoomedDiv.querySelector('.dragClose');
        if (closeBtn) closeBtn.click();
    }
}

function injectChatButton(mesNode) {
    const avatarWrapper = mesNode.querySelector('.mesAvatarWrapper');
    if (!avatarWrapper || avatarWrapper.querySelector('.st-trigger-zoom-btn')) return;

    // 开关①：创建并在头像下方生成小图标进入图库快捷键
    const btn = document.createElement('div');
    btn.className = 'st-trigger-zoom-btn fa-solid fa-images';
    btn.title = '打开原图及图库控制';
    
    avatarWrapper.appendChild(btn);
}

// ======================== 原图控制面板（三个主要按钮行） ========================

function injectControlBarButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('.st-avatar-injected-btns')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    zoomedDiv.style.removeProperty('height');
    zoomedDiv.style.removeProperty('width');

    const btnContainer = document.createElement('div');
    btnContainer.className = 'st-avatar-injected-btns';

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    const originalSrc = img.src;
    const avatarId = getAvatarIdFromSrc(originalSrc);
    const isUser = isUserAvatar(originalSrc);
    const theme = getCurrentTheme();

    // 按钮1：编辑
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.title = '编辑与无级旋转';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    // 辅助恢复按键
    const revertBtn = document.createElement('div');
    revertBtn.id = 'st-revert-crop-btn';
    revertBtn.className = 'fa-solid fa-arrow-rotate-left';
    revertBtn.title = '重置修改';
    
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    revertBtn.style.display = extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey] ? 'flex' : 'none';

    revertBtn.onclick = async (e) => {
        e.stopPropagation();
        if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) {
            const cropPath = extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            await deleteFromBackend(cropPath);
            delete extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            saveSettingsDebounced();
            applyAvatarCss();
            toastr.success('已还原初始化');
            revertBtn.style.display = 'none';
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    };

    // 按钮2：图库
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-folder-open';
    galleryBtn.title = '进入角色图库';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    btnContainer.appendChild(revertBtn);
    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    // 按钮3：关闭直接复用原版的 dragClose 元素，并把它挪到最右边
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// ======================== 全局监听与初始化 ========================

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyAvatarCss(); 
    }
}, 1000);

// 开关设置页面渲染：支持两个独立开关切换
setInterval(() => {
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isVisible = !!extension_settings.avatarGalleryBtnVisible;
            const isClickEnabled = !!extension_settings.clickAvatarToGallery;
            
            container.innerHTML = `
                <span data-i18n="Avatar Gallery Management">头像图库管理：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开关①" style="margin-right: 8px !important;">
                    <option value="false" ${!isVisible ? 'selected' : ''}>隐藏小按钮</option>
                    <option value="true" ${isVisible ? 'selected' : ''}>显示小按钮</option>
                </select>
                <select id="st-avatar-click-select" class="widthNatural flex1 margin0 text_pole" title="开关②">
                    <option value="false" ${!isClickEnabled ? 'selected' : ''}>点击放大：关</option>
                    <option value="true" ${isClickEnabled ? 'selected' : ''}>点击放大：开</option>
                </select>
            `;
            targetContainer.appendChild(container);
            
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarGalleryBtnVisible = (e.target.value === 'true');
                saveSettingsDebounced();
                updatePluginState();
            });
            document.getElementById('st-avatar-click-select').addEventListener('change', (e) => {
                extension_settings.clickAvatarToGallery = (e.target.value === 'true');
                saveSettingsDebounced();
                updatePluginState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    updatePluginState();

    // 监听开关①：点击小图标触发原图弹窗
    $(document).on('click', '.st-trigger-zoom-btn', function(e) {
        e.stopPropagation();
        const avatarImg = $(this).closest('.mesAvatarWrapper').find('.avatar img');
        if (avatarImg.length) {
            // 通过原生事件唤出原版放大层，再由下方的观察器注入按钮
            const originalPointerEvents = avatarImg.css('pointer-events');
            avatarImg.css('pointer-events', 'auto');
            avatarImg.click();
            avatarImg.css('pointer-events', originalPointerEvents);
        }
    });

    // 监听开关②：直接点击头像的行为劫持
    $(document).on('click', '.mesAvatarWrapper .avatar img', function(e) {
        if (!extension_settings.clickAvatarToGallery) {
            // 如果点击放大为关闭，不执行特殊拦截，直接回归默认放大操作
            return;
        }
    });
    
    // 监听文件加载更替
    document.body.addEventListener('change', (e) => {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            const id = e.target.id;
            if (['add_avatar_button', 'character_replace_file', 'avatar_upload_file', 'group_avatar_button'].includes(id)) {
                let oldAvatarId = lastValidAvatarId;
                const previewImg = document.getElementById('avatar_load_preview') || document.querySelector('#group_avatar_preview .avatar img');
                
                if (previewImg) {
                    const src = previewImg.getAttribute('src');
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        oldAvatarId = getAvatarIdFromSrc(src);
                    }
                }

                if (oldAvatarId && oldAvatarId !== 'thumbnail') {
                    let checkCount = 0;
                    const migrateInterval = setInterval(() => {
                        checkCount++;
                        if (previewImg) {
                            const currentSrc = previewImg.getAttribute('src');
                            if (currentSrc && !currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
                                const newAvatarId = getAvatarIdFromSrc(currentSrc);
                                if (newAvatarId !== oldAvatarId && newAvatarId !== 'thumbnail') {
                                    if (extension_settings.charGalleryImages && extension_settings.charGalleryImages[oldAvatarId]) {
                                        extension_settings.charGalleryImages[newAvatarId] = JSON.parse(JSON.stringify(extension_settings.charGalleryImages[oldAvatarId]));
                                        delete extension_settings.charGalleryImages[oldAvatarId];
                                    }
                                    if (extension_settings.avatarThemeBindings) {
                                        for (const t in extension_settings.avatarThemeBindings) {
                                            if (extension_settings.avatarThemeBindings[t][oldAvatarId]) {
                                                extension_settings.avatarThemeBindings[t][newAvatarId] = extension_settings.avatarThemeBindings[t][oldAvatarId];
                                                delete extension_settings.avatarThemeBindings[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    if (extension_settings.avatarThemeCrops) {
                                        for (const t in extension_settings.avatarThemeCrops) {
                                            if (extension_settings.avatarThemeCrops[t][oldAvatarId]) {
                                                const oldOriginalCropPath = extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                if (oldOriginalCropPath) {
                                                    deleteFromBackend(oldOriginalCropPath);
                                                    delete extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                }
                                                extension_settings.avatarThemeCrops[t][newAvatarId] = extension_settings.avatarThemeCrops[t][oldAvatarId];
                                                delete extension_settings.avatarThemeCrops[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    saveSettingsDebounced();
                                    applyAvatarCss();
                                }
                                clearInterval(migrateInterval);
                            }
                        }
                        if (checkCount > 20) clearInterval(migrateInterval);
                    }, 500);
                }
            }
        }
    });

    console.log('[Avatar Gallery & Cropper] Loaded customized settings with embedded Cropper range slider.');

    // 全局观察者：负责给弹出的放大原图注入三个主控按钮
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    let zoomedNode = null;
                    if (node.classList.contains('zoomed_avatar')) zoomedNode = node;
                    else zoomedNode = node.querySelector('.zoomed_avatar');

                    if (zoomedNode) {
                        // 统一呼出原图控制栏（拥有：重置、编辑、图库、原版关闭）
                        injectControlBarButtons(zoomedNode);
                    }
                    
                    if (node.classList.contains('mes')) {
                        injectChatButton(node);
                    } else {
                        const messages = node.querySelectorAll('.mes');
                        messages.forEach(injectChatButton);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
