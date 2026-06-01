import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 初始化数据与状态迁移
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;
if (extension_settings.avatarGalleryPluginEnabled !== undefined) {
    extension_settings.avatarGalleryBtnVisible = extension_settings.avatarGalleryPluginEnabled;
    delete extension_settings.avatarGalleryPluginEnabled;
}

// 核心开关初始化
if (extension_settings.avatarGalleryBtnVisible === undefined) extension_settings.avatarGalleryBtnVisible = true; // 开关①
if (extension_settings.clickAvatarToZoom === undefined) extension_settings.clickAvatarToZoom = true; // 开关②

if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};

if (extension_settings.avatarThemeCrops) {
    for (const theme in extension_settings.avatarThemeCrops) {
        for (const avatarId in extension_settings.avatarThemeCrops[theme]) {
            const val = extension_settings.avatarThemeCrops[theme][avatarId];
            if (typeof val === 'string') {
                const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
                extension_settings.avatarThemeCrops[theme][avatarId] = {};
                extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = val;
            }
        }
    }
}

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        const parts = urlObj.pathname.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
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

// ======================== 后端文件操作 ========================

async function uploadToBackend(base64Data, prefix = "image") {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}_${randomSuffix}`;
    const requestBody = { image: b64, format: 'png', ch_name: '', filename: filename };
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
    } catch(e) { }
    return null;
}

async function uploadToBackendExact(base64Data, exactFilename) {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const requestBody = { image: b64, format: 'png', ch_name: '', filename: exactFilename };
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
    } catch(e) { }
    return null;
}

async function deleteFromBackend(path) {
    try {
        const cleanPath = path.split('?')[0];
        await fetch('/api/images/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ path: cleanPath }) });
    } catch (e) { }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    try {
        const fetchUrl = url.includes('?') ? url : `${url}?t=${Date.now()}`;
        const data = await fetch(fetchUrl);
        if (!data.ok) throw new Error(`HTTP: ${data.status}`);
        const blob = await data.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取 Blob 失败'));
            reader.readAsDataURL(blob); 
        });
    } catch (error) {
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
                let width = img.width, height = img.height;
                if (width > height && width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; }
                else if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== CSS 引擎 & 插件状态管理 ========================

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
    const isClickEnabled = !!extension_settings.clickAvatarToZoom;
    
    // 执行开关②：通过控制 body 的 css class 来决定是否屏蔽原生头像点击
    if (isClickEnabled) document.body.classList.remove('st-disable-avatar-click');
    else document.body.classList.add('st-disable-avatar-click');

    // 执行开关①：管理图标的显示与隐藏
    let btnVisibilityStyle = document.getElementById('st-avatar-btn-visibility');
    if (!btnVisibilityStyle) {
        btnVisibilityStyle = document.createElement('style');
        btnVisibilityStyle.id = 'st-avatar-btn-visibility';
        document.head.appendChild(btnVisibilityStyle);
    }
    
    if (isBtnVisible) {
        btnVisibilityStyle.textContent = ''; 
        document.querySelectorAll('.mes').forEach(injectChatButton);
    } else {
        btnVisibilityStyle.textContent = '.st-trigger-zoom-btn { display: none !important; }'; 
    }
    
    applyAvatarCss();
}

async function deleteImages(pathsToDelete, avatarId, isUser) {
    if (isUser) extension_settings.userGalleryImages = extension_settings.userGalleryImages.filter(p => !pathsToDelete.includes(p));
    else extension_settings.charGalleryImages[avatarId] = extension_settings.charGalleryImages[avatarId].filter(p => !pathsToDelete.includes(p));

    if (extension_settings.avatarThemeBindings) {
        for (const theme in extension_settings.avatarThemeBindings) {
            const bindings = extension_settings.avatarThemeBindings[theme];
            if (pathsToDelete.includes(bindings[avatarId])) delete bindings[avatarId];
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
    for (const path of pathsToDelete) await deleteFromBackend(path);
    saveSettingsDebounced();
    applyAvatarCss();
}

// ======================== 图库面板 ========================

async function openGallery(isUser, avatarId, originalSrc, zoomedDiv) {
    if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
    if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
    if (!isUser && !extension_settings.charGalleryImages[avatarId]) extension_settings.charGalleryImages[avatarId] = [];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户图库' : '角色图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理图库"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button margin0" id="btn-alt-delete-confirm" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i> <span>点击删除</span></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
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
        const inputUpload = document.getElementById('input-alt-upload');

        function renderGrid() {
            grid.innerHTML = '';
            const cleanOriginalSrc = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (!tempSelectedPath ? ' selected' : '');
            origDiv.innerHTML = `<img src="${cleanOriginalSrc}" title="解除绑定 (恢复原图)">`;
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
                        if (isDeleteMode) { e.stopPropagation(); toggleDeleteMark(path, itemDiv); } 
                        else selectAvatar(path); 
                    };
                    grid.appendChild(itemDiv);
                });
            }
        }
        function selectAvatar(path) { if (isDeleteMode) return; tempSelectedPath = path; renderGrid(); }
        function toggleDeleteMark(path, element) {
            if (itemsToDelete.has(path)) { itemsToDelete.delete(path); element.classList.remove('to-delete'); } 
            else { itemsToDelete.add(path); element.classList.add('to-delete'); }
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`确认删除选中的 ${itemsToDelete.size} 张图片？`, POPUP_TYPE.CONFIRM, '', { okButton: '确认', cancelButton: '取消' });
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
            if (itemsToDelete.has(tempSelectedPath)) tempSelectedPath = null;
            await deleteImages(Array.from(itemsToDelete), avatarId, isUser);
            btnManage.click(); toastr.success('已删除');
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
            saveSettingsDebounced(); renderGrid(); inputUpload.value = ''; toastr.success(`上传成功`);
        };
        renderGrid();
    }, 100);

    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: '确认应用', cancelButton: '取消' });
    
    if (result === POPUP_RESULT.AFFIRMATIVE && tempSelectedPath !== currentBinding) {
        const theme = getCurrentTheme();
        if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
        if (!extension_settings.avatarThemeBindings[theme]) extension_settings.avatarThemeBindings[theme] = {};
        
        if (tempSelectedPath === null) {
            delete extension_settings.avatarThemeBindings[theme][avatarId];
            toastr.success('已恢复原图并解除绑定');
        } else {
            extension_settings.avatarThemeBindings[theme][avatarId] = tempSelectedPath;
            toastr.success('已绑定并应用');
        }
        saveSettingsDebounced();
        applyAvatarCss();
        const closeBtn = zoomedDiv.querySelector('.dragClose');
        if (closeBtn) closeBtn.click();
    }
}

// ======================== 编辑(裁剪)页面与无级旋转功能 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, isUser, zoomedDiv) {
    if (avatarId === 'thumbnail') return toastr.error('无法获取图片');

    const theme = getCurrentTheme();
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    let sourcePath = extension_settings.avatarThemeBindings?.[theme]?.[avatarId];

    if (!sourcePath) sourcePath = isUser ? `/User Avatars/${encodeURIComponent(avatarId)}` : `/characters/${encodeURIComponent(avatarId)}`;
    else if (!sourcePath.startsWith('/') && !sourcePath.startsWith('http') && !sourcePath.startsWith('data:')) sourcePath = '/' + sourcePath; 

    let base64Original;
    try {
        base64Original = await getBase64FromUrl(sourcePath);
    } catch (e) {
        return toastr.error(`获取数据失败，无法编辑: ${e.message}`);
    }

    // 呼出ST自带的裁剪弹窗
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    // 核心注入：在弹窗的底层添加无级旋转长滑条
    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            const cropper = cropperImg.cropper;
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;

            const popupBody = document.querySelector('#dialogue_popup .popup-body');
            if (popupBody && !document.getElementById('st-crop-rotate-slider')) {
                // 构建无级旋转 UI，放在最底层
                const sliderHTML = `
                    <div id="st-crop-rotate-container">
                        <i class="fa-solid fa-arrow-rotate-left" style="cursor:pointer;" id="st-crop-rot-left" title="左旋 90°"></i>
                        <input type="range" id="st-crop-rotate-slider" min="-180" max="180" value="0" step="1">
                        <i class="fa-solid fa-arrow-rotate-right" style="cursor:pointer;" id="st-crop-rot-right" title="右旋 90°"></i>
                        <span id="st-crop-rotate-val">0°</span>
                    </div>
                `;
                popupBody.insertAdjacentHTML('beforeend', sliderHTML);

                const slider = document.getElementById('st-crop-rotate-slider');
                const valDisplay = document.getElementById('st-crop-rotate-val');

                // 滑动事件：利用原生 cropperjs 的 rotateTo 接口，无级调节并且不损失图片画质
                slider.addEventListener('input', (e) => {
                    const deg = Number(e.target.value);
                    valDisplay.textContent = deg + '°';
                    cropper.rotateTo(deg);
                });

                // 为两侧的小图标绑定快捷旋转 90° 的功能
                document.getElementById('st-crop-rot-left').onclick = () => {
                    let next = Math.max(-180, Number(slider.value) - 90);
                    slider.value = next; slider.dispatchEvent(new Event('input'));
                };
                document.getElementById('st-crop-rot-right').onclick = () => {
                    let next = Math.min(180, Number(slider.value) + 90);
                    slider.value = next; slider.dispatchEvent(new Event('input'));
                };
            }
        }
    }, 150);

    // 等待用户点击弹窗上的“确认”
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
        if (!path) return toastr.error('无法保存图片');

        extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = `${path}?t=${Date.now()}`;
        saveSettingsDebounced(); applyAvatarCss(); toastr.success('已应用到主界面');

        const closeBtn = zoomedDiv.querySelector('.dragClose');
        if (closeBtn) closeBtn.click();
    }
}

// ======================== 主界面控制条与按钮注入 ========================

function injectChatButton(mesNode) {
    const wrapper = mesNode.querySelector('.mesAvatarWrapper');
    if (!wrapper || wrapper.querySelector('.st-trigger-zoom-btn')) return;

    // 开关①的小图标：放置在头像下方区域
    const btn = document.createElement('div');
    btn.className = 'st-trigger-zoom-btn fa-solid fa-image-portrait';
    btn.title = '打开原图以管理图库或编辑';
    wrapper.appendChild(btn);
}

function injectControlBarButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('.st-avatar-injected-btns')) return;
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    // 创建容器，在右上角塞入功能按键
    const btnContainer = document.createElement('div');
    btnContainer.className = 'st-avatar-injected-btns';

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    const originalSrc = img.src;
    const avatarId = getAvatarIdFromSrc(originalSrc);
    const isUser = isUserAvatar(originalSrc);
    const theme = getCurrentTheme();

    // 1. 还原按键
    const revertBtn = document.createElement('div');
    revertBtn.id = 'st-revert-crop-btn';
    revertBtn.className = 'fa-solid fa-arrow-rotate-left';
    revertBtn.title = '还原 (取消当前的剪裁/旋转效果)';
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    revertBtn.style.display = (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) ? 'flex' : 'none';

    revertBtn.onclick = async (e) => {
        e.stopPropagation();
        if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) {
            await deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]);
            delete extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            saveSettingsDebounced(); applyAvatarCss(); toastr.success('已还原');
            revertBtn.style.display = 'none';
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    };

    // 2. 编辑按键 (进入裁剪与旋转)
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.title = '编辑 (裁剪与旋转)';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    // 3. 图库按键
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-images';
    galleryBtn.title = '图库 (更换或管理)';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    // 按要求顺序注入: 还原 -> 编辑 -> 图库。 （关闭按键原生就在旁边）
    btnContainer.appendChild(revertBtn);
    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// ======================== 初始化全局监听 ========================

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) { lastTheme = currentTheme; applyAvatarCss(); }
}, 1000);

// 创建设置界面的两个控制开关 UI
setInterval(() => {
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isVisible = !!extension_settings.avatarGalleryBtnVisible;
            const isClickEnabled = !!extension_settings.clickAvatarToZoom;
            
            container.innerHTML = `
                <span data-i18n="Avatar Gallery Management">头像图库管理：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开关①：在头像下方显示管理小图标" style="margin-right: 8px !important;">
                    <option value="false" ${!isVisible ? 'selected' : ''}>开关① 隐藏按钮</option>
                    <option value="true" ${isVisible ? 'selected' : ''}>开关① 显示按钮</option>
                </select>
                <select id="st-avatar-click-select" class="widthNatural flex1 margin0 text_pole" title="开关②：允许直接点击角色图片进入放大界面">
                    <option value="false" ${!isClickEnabled ? 'selected' : ''}>开关② 点击放大关</option>
                    <option value="true" ${isClickEnabled ? 'selected' : ''}>开关② 点击放大开</option>
                </select>
            `;
            targetContainer.appendChild(container);
            
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarGalleryBtnVisible = (e.target.value === 'true');
                saveSettingsDebounced(); updatePluginState();
            });
            document.getElementById('st-avatar-click-select').addEventListener('change', (e) => {
                extension_settings.clickAvatarToZoom = (e.target.value === 'true');
                saveSettingsDebounced(); updatePluginState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    updatePluginState();

    // 如果通过开关①的小按钮点击，通过 JS 手动触发原生图片的放大动作，无视 CSS 的拦截
    $(document).on('click', '.st-trigger-zoom-btn', function(e) {
        e.stopPropagation();
        const avatarImg = $(this).closest('.mesAvatarWrapper').find('.avatar img');
        if (avatarImg.length) {
            const rawImg = avatarImg.get(0);
            rawImg.style.pointerEvents = 'auto'; // 临时解封
            avatarImg.trigger('click'); // 触发放大
            if (!extension_settings.clickAvatarToZoom) rawImg.style.pointerEvents = 'none'; // 如果开关②是关的，重新封印
        }
    });

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    let zoomedNode = null;
                    if (node.classList.contains('zoomed_avatar')) zoomedNode = node;
                    else zoomedNode = node.querySelector('.zoomed_avatar');

                    if (zoomedNode) {
                        injectControlBarButtons(zoomedNode);
                    }
                    
                    if (node.classList.contains('mes')) injectChatButton(node);
                    else node.querySelectorAll('.mes').forEach(injectChatButton);
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
