import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 清理和收束历史开关遗留
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;
if (extension_settings.clickAvatarToZoom !== undefined) delete extension_settings.clickAvatarToZoom;

// 仅保留一个核心开关
if (extension_settings.avatarGalleryBtnVisible === undefined) extension_settings.avatarGalleryBtnVisible = true; 

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

// ======================== 后端文件处理 ========================

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

// ======================== CSS 注入引擎 ========================

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

    // 呼出自带裁剪弹窗
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    // 【修复 Bug ②】：采用逆向检索机制，精准拦截当前活跃的 Cropper 实例并强制覆写旋转权限
    let pollCount = 0;
    const injectInterval = setInterval(() => {
        pollCount++;
        const cropperImgs = document.querySelectorAll('.cropper-hidden');
        let activeCropperImg = null;
        
        // 从后往前寻找，锁定最新、最顶层处于唤醒状态的 Cropper
        for (let i = cropperImgs.length - 1; i >= 0; i--) {
            if (cropperImgs[i].cropper) {
                activeCropperImg = cropperImgs[i];
                break;
            }
        }

        if (activeCropperImg && activeCropperImg.cropper) {
            clearInterval(injectInterval);
            const cropper = activeCropperImg.cropper;
            
            // 核心修复点：强制解除酒馆可能配置的底层旋转限制
            cropper.options.rotatable = true; 
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;

            const container = activeCropperImg.nextElementSibling;
            let popupBody = container ? container.closest('.popup-body') : null;
            if (!popupBody) popupBody = activeCropperImg.closest('.popup-body') || activeCropperImg.parentElement;
            
            if (popupBody && !document.getElementById('st-crop-rotate-slider')) {
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

                slider.addEventListener('input', (e) => {
                    const deg = Number(e.target.value);
                    valDisplay.textContent = deg + '°';
                    cropper.options.rotatable = true; // 双重锁，防止运行期被系统重写覆盖
                    cropper.rotateTo(deg); // 执行无级绝对角度旋转
                });

                document.getElementById('st-crop-rot-left').onclick = () => {
                    let next = Number(slider.value) - 90;
                    if (next < -180) next += 360;
                    slider.value = next; slider.dispatchEvent(new Event('input'));
                };
                document.getElementById('st-crop-rot-right').onclick = () => {
                    let next = Number(slider.value) + 90;
                    if (next > 180) next -= 360;
                    slider.value = next; slider.dispatchEvent(new Event('input'));
                };
            }
        }
        if (pollCount >= 40) clearInterval(injectInterval);
    }, 100);

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

// ======================== 控制按键注入 ========================

function injectChatButton(mesNode) {
    const wrapper = mesNode.querySelector('.mesAvatarWrapper');
    if (!wrapper || wrapper.querySelector('.st-trigger-zoom-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'st-trigger-zoom-btn fa-solid fa-image-portrait';
    btn.title = '打开原图以管理图库或编辑';
    wrapper.appendChild(btn);
}

function injectControlBarButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('.st-avatar-injected-btns')) return;
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const btnContainer = document.createElement('div');
    btnContainer.className = 'st-avatar-injected-btns';

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    const originalSrc = img.src;
    const avatarId = getAvatarIdFromSrc(originalSrc);
    const isUser = isUserAvatar(originalSrc);
    const theme = getCurrentTheme();

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

    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.title = '编辑 (裁剪与旋转)';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-images';
    galleryBtn.title = '图库 (更换或管理)';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    btnContainer.appendChild(revertBtn);
    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// ======================== 初始化与事件桥接 ========================

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) { lastTheme = currentTheme; applyAvatarCss(); }
}, 1000);

// 开关①控制界面渲染
setInterval(() => {
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isVisible = !!extension_settings.avatarGalleryBtnVisible;
            
            container.innerHTML = `
                <span data-i18n="Avatar Gallery Management">头像图库管理：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="在头像下方显示快捷进入图库的小图标">
                    <option value="false" ${!isVisible ? 'selected' : ''}>隐藏按钮</option>
                    <option value="true" ${isVisible ? 'selected' : ''}>显示按钮</option>
                </select>
            `;
            targetContainer.appendChild(container);
            
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarGalleryBtnVisible = (e.target.value === 'true');
                saveSettingsDebounced(); updatePluginState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    updatePluginState();

    // 【修复 Bug ①】：由虚拟容器截获图片源，绕过第三方主题的一切 DOM 改动与事件拦截，安全送达酒馆核心监听器
    $(document).on('click', '.st-trigger-zoom-btn', function(e) {
        e.stopPropagation();
        const mesNode = $(this).closest('.mes');
        let detectedSrc = null;

        // 1. 尝试从标准/变体 img 标签提取路径
        const standardImg = mesNode.find('.mesAvatarWrapper img, .avatar img, img[class*="avatar"]');
        if (standardImg.length) {
            detectedSrc = standardImg.attr('src');
        }

        // 2. 如果没获取到，说明主题使用了背景图 div (如部分高级主题)，启动背景图逆向解析
        if (!detectedSrc) {
            const bgDivs = mesNode.find('.avatar, [class*="avatar"], .mesAvatarWrapper');
            bgDivs.each(function() {
                const bgValue = $(this).css('background-image');
                if (bgValue && bgValue !== 'none') {
                    const match = bgValue.match(/^url\(['"]?([^'"]+)['"]?\)$/);
                    if (match) {
                        detectedSrc = match[1];
                        return false; 
                    }
                }
            });
        }

        if (!detectedSrc) return; // 没拿到有效图片则阻断，防止抛错

        // 3. 在内存中伪造一个完美符合酒馆原生全局监听要求的虚拟环境节点
        const fakeShell = document.createElement('div');
        fakeShell.className = 'avatar';
        fakeShell.style.display = 'none';
        
        const fakeImg = document.createElement('img');
        fakeImg.src = detectedSrc;
        
        fakeShell.appendChild(fakeImg);
        document.body.appendChild(fakeShell);
        
        // 4. 发送原生冒泡点击，直接投递给酒馆核心
        fakeImg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        
        // 5. 阅后即焚，清理战场
        fakeShell.remove();
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
