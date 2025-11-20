const RESOURCE_PACK_BASE_PATH = './resource_pack';
const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];
const HORIZONTAL_FACES = ['north', 'east', 'south', 'west'];
const DIRECTION_INDEX = { north: 0, east: 1, south: 2, west: 3 };
const FACING_FROM_INDEX = ['south', 'west', 'north', 'east'];

function stripJsonComments(input = '') {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const next = input[i + 1];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }

        if (char === '/' && next === '/') {
            while (i < input.length && input[i] !== '\n') {
                i++;
            }
            output += '\n';
            continue;
        }

        if (char === '/' && next === '*') {
            i += 2;
            while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
                i++;
            }
            i++;
            continue;
        }

        output += char;
    }

    return output;
}

function normalizeTextureMap(textureEntry, fallbackId) {
    const faces = {
        up: null,
        down: null,
        north: null,
        south: null,
        east: null,
        west: null,
    };

    const apply = (id, targets) => {
        targets.forEach((face) => {
            faces[face] = id || faces[face];
        });
    };

    if (typeof textureEntry === 'string') {
        apply(textureEntry, Object.keys(faces));
    } else if (textureEntry && typeof textureEntry === 'object') {
        if (textureEntry.default) {
            apply(textureEntry.default, Object.keys(faces));
        }
        if (textureEntry.side) {
            apply(textureEntry.side, ['north', 'south', 'east', 'west']);
        }

        const aliasMap = {
            top: ['up'],
            bottom: ['down'],
            up: ['up'],
            down: ['down'],
            north: ['north'],
            south: ['south'],
            east: ['east'],
            west: ['west'],
            front: ['south'],
            back: ['north'],
        };

        Object.entries(textureEntry).forEach(([key, value]) => {
            const normalized = aliasMap[key];
            if (normalized) {
                apply(value, normalized);
            }
        });
    }

    const fallback = fallbackId || 'missing';
    Object.keys(faces).forEach((face) => {
        if (!faces[face]) {
            faces[face] = fallback;
        }
    });

    return faces;
}

function applyAxisOrientation(faces, axis) {
    if (!axis || axis === 'y') {
        return { ...faces };
    }

    const result = { ...faces };
    if (axis === 'x') {
        result.east = faces.up;
        result.west = faces.down;
        result.up = faces.north;
        result.down = faces.south;
    } else if (axis === 'z') {
        result.south = faces.up;
        result.north = faces.down;
        result.up = faces.east;
        result.down = faces.west;
    }
    return result;
}

function rotateHorizontalFaces(faces, targetDirection) {
    if (!targetDirection) {
        return { ...faces };
    }
    const rotationIndex = DIRECTION_INDEX[targetDirection];
    if (typeof rotationIndex === 'undefined') {
        return { ...faces };
    }

    const delta = (rotationIndex - DIRECTION_INDEX.south + 4) % 4;
    if (delta === 0) {
        return { ...faces };
    }

    const rotated = { ...faces };
    HORIZONTAL_FACES.forEach((dir, idx) => {
        const sourceIdx = (idx - delta + 4) % 4;
        rotated[dir] = faces[HORIZONTAL_FACES[sourceIdx]];
    });
    return rotated;
}

function resolveFacing(states = {}) {
    if (!states) return null;

    const facing =
        states.facing ||
        states['minecraft:facing'] ||
        states['minecraft:cardinal_direction'] ||
        states.cardinal_direction;
    if (typeof facing === 'string') {
        return facing;
    }

    const numeric =
        states.facing_direction ??
        states['minecraft:facing_direction'] ??
        states.direction;
    if (typeof numeric === 'number') {
        return FACING_FROM_INDEX[Math.abs(numeric) % FACING_FROM_INDEX.length];
    }

    return null;
}

export class ResourcePackTextureManager {
    constructor(basePath = RESOURCE_PACK_BASE_PATH) {
        this.basePath = basePath.replace(/\/$/, '');
        this.blocksDataPromise = null;
        this.terrainDataPromise = null;
        this.textureCache = new Map();
        this.materialCache = new Map();
        this.previewCache = new Map();
        this.textureLoader = new THREE.TextureLoader();
        this.tgaLoader = this.createTgaLoader();
        this.fallbackVisual = null;
        this.sourceMode = 'static';
        this.zip = null;
        this.zipLookupCache = new Map();
    }

    createTgaLoader() {
        if (typeof THREE === 'undefined' || typeof THREE.TGALoader === 'undefined') {
            console.warn('THREE.TGALoader is not available. TGA textures will not render.');
            return null;
        }
        return new THREE.TGALoader();
    }

    resetCaches(resetTextures = false) {
        this.blocksDataPromise = null;
        this.terrainDataPromise = null;
        if (resetTextures) {
            this.textureCache.forEach((tex) => tex?.dispose?.());
            this.textureCache.clear();
            this.materialCache.clear();
            this.previewCache.clear();
        }
    }

    async setZipFile(file) {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip library is required to load resource packs.');
        }
        this.zip = await JSZip.loadAsync(file);
        this.sourceMode = 'zip';
        this.zipLookupCache = new Map();
        this.resetCaches(true);
    }

    clearZipSource() {
        this.zip = null;
        this.sourceMode = 'static';
        this.zipLookupCache = new Map();
        this.resetCaches(true);
    }

    async loadBlocksData() {
        if (!this.blocksDataPromise) {
            this.blocksDataPromise = this.readTextFile('blocks.json').then((text) => JSON.parse(text));
        }
        return this.blocksDataPromise;
    }

    async loadTerrainData() {
        if (!this.terrainDataPromise) {
            this.terrainDataPromise = this.readTextFile('textures/terrain_texture.json').then((text) =>
                JSON.parse(stripJsonComments(text))
            );
        }
        return this.terrainDataPromise;
    }

    normalizeBlockName(name = '') {
        return name.replace(/^minecraft:/, '');
    }

    async getBlockDefinition(blockName) {
        const blocks = await this.loadBlocksData();
        const normalized = this.normalizeBlockName(blockName);
        return blocks[normalized] ?? null;
    }

    async getTextureRecord(textureId) {
        const terrain = await this.loadTerrainData();
        return terrain?.texture_data?.[textureId];
    }

    resolveTexturePath(record, textureId) {
        if (record && record.textures) {
            const data = record.textures;
            if (typeof data === 'string') {
                return data;
            }
            if (Array.isArray(data)) {
                for (const entry of data) {
                    if (typeof entry === 'string') {
                        return entry;
                    }
                    if (entry && typeof entry === 'object' && entry.path) {
                        return entry.path;
                    }
                }
            }
            if (data && typeof data === 'object' && data.path) {
                return data.path;
            }
        }
        return textureId;
    }

    async loadTextureAsset(textureId = 'missing') {
        const cacheKey = textureId || 'missing';
        if (this.textureCache.has(cacheKey)) {
            return this.textureCache.get(cacheKey);
        }

        const record = await this.getTextureRecord(textureId);
        const texturePath = this.resolveTexturePath(record, textureId);

        let texture = await this.loadTextureByPath(texturePath).catch(() => null);
        if (!texture && textureId !== 'missing') {
            texture = await this.loadTextureAsset('missing');
        }

        if (!texture) {
            const fallbackTexture = new THREE.Texture();
            fallbackTexture.needsUpdate = true;
            this.textureCache.set(cacheKey, fallbackTexture);
            return fallbackTexture;
        }

        this.configureTexture(texture);
        this.textureCache.set(cacheKey, texture);
        return texture;
    }

    async loadTextureByPath(texturePath) {
        const normalized = texturePath.replace(/^\.\//, '');
        const candidates = [`${normalized}.png`, `${normalized}.tga`];
        for (const candidate of candidates) {
            const texture = await this.loadTextureCandidate(candidate);
            if (texture) {
                return texture;
            }
        }
        return null;
    }

    async loadTextureCandidate(candidatePath) {
        const isTga = candidatePath.toLowerCase().endsWith('.tga');
        if (isTga && !this.tgaLoader) {
            return null;
        }
        const loader = isTga ? this.tgaLoader : this.textureLoader;

        if (this.sourceMode === 'zip') {
            const fileEntry = await this.findZipEntry(candidatePath);
            if (!fileEntry) {
                return null;
            }
            const arrayBuffer = await fileEntry.async('arraybuffer');
            const blob = new Blob([arrayBuffer], { type: isTga ? 'image/x-tga' : 'image/png' });
            const objectUrl = URL.createObjectURL(blob);
            try {
                const texture = await this.loadTextureFromUrl(objectUrl, loader);
                texture.userData = texture.userData || {};
                texture.userData.sourcePath = candidatePath;
                // Try to generate a stable preview data URL for thumbnails when possible
                try {
                    const img = texture.image;
                    if (img instanceof HTMLImageElement) {
                        // draw to canvas to create a data URL
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth || img.width || 16;
                        canvas.height = img.naturalHeight || img.height || 16;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        texture.userData.previewSrc = canvas.toDataURL();
                    } else if (img instanceof HTMLCanvasElement) {
                        texture.userData.previewSrc = img.toDataURL();
                    }
                } catch (e) {
                    // Non-fatal: preview generation failed
                    console.warn('Failed to generate preview data URL for', candidatePath, e);
                }

                return texture;
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        }

        const url = `${this.basePath}/${candidatePath}`;
        try {
            const texture = await this.loadTextureFromUrl(url, loader);
            texture.userData = texture.userData || {};
            texture.userData.sourcePath = url;
            return texture;
        } catch (error) {
            return null;
        }
    }

    loadTextureFromUrl(url, loader) {
        return new Promise((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
        });
    }

    configureTexture(texture) {
        const MAX_DIM = 1024; // if textures are larger than this, resample down to save GPU memory
        texture.encoding = THREE.sRGBEncoding;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.LinearMipMapLinearFilter;

        try {
            const img = texture.image;
            if (img && (img.width > MAX_DIM || img.height > MAX_DIM)) {
                console.info(`configureTexture: downscaling large texture (${img.width}x${img.height}) to ${MAX_DIM}px max`);
                const scale = MAX_DIM / Math.max(img.width, img.height);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.floor(img.width * scale));
                canvas.height = Math.max(1, Math.floor(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                texture.image = canvas;
                texture.needsUpdate = true;
                texture.userData = texture.userData || {};
                texture.userData.resized = true;
            }
        } catch (e) {
            console.warn('configureTexture: failed to resample texture', e);
        }
    }

    getTexturePreviewSrc(texture) {
        if (!texture) return '';
        if (texture.userData?.previewSrc) {
            return texture.userData.previewSrc;
        }

        let src = '';
        const image = texture.image;
        if (image instanceof HTMLImageElement) {
            src = image.currentSrc || image.src || texture.userData?.sourcePath || '';
        } else if (image instanceof HTMLCanvasElement) {
            src = image.toDataURL();
        } else if (image && image.data && image.width && image.height) {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
            ctx.putImageData(imageData, 0, 0);
            src = canvas.toDataURL();
        } else if (texture.userData?.sourcePath) {
            src = texture.userData.sourcePath;
        }

        texture.userData = texture.userData || {};
        texture.userData.previewSrc = src;
        return src;
    }

    getMaterialKey(entry) {
        const axis = entry.states?.pillar_axis ?? entry.states?.axis ?? 'y';
        const facing = resolveFacing(entry.states) ?? 'south';
        return `${entry.name}|axis:${axis}|facing:${facing}`;
    }

    async getBlockVisual(entry) {
        const key = this.getMaterialKey(entry);
        if (this.materialCache.has(key)) {
            return this.materialCache.get(key);
        }
        // Be tolerant to missing blocks.json or lookup errors
        let blockDefinition = null;
        try {
            blockDefinition = await this.getBlockDefinition(entry.name);
        } catch (e) {
            console.warn('getBlockVisual: failed to get block definition for', entry.name, e);
            blockDefinition = null;
        }
        const faceMap = this.normalizeEntryFaces(blockDefinition, entry);
        const renderMethod = blockDefinition?.render_method ?? 'opaque';

            const textures = await Promise.all(
                FACE_ORDER.map((face) => this.loadTextureAsset(faceMap[face]).catch(() => null))
            );
            const materials = textures.map((texture, idx) => {
                try {
                    return this.createMaterial(texture, renderMethod);
                } catch (e) {
                    console.warn(`createMaterial failed for face ${FACE_ORDER[idx]} of ${entry.name}`, e);
                    return new THREE.MeshStandardMaterial({ color: 0x8e8e8e });
                }
            });
        const previewTexture = textures[2] || textures[4] || textures.find(Boolean);
        const previewSrc = this.getTexturePreviewSrc(previewTexture);

    const visual = { materials: materials.map(m => m || new THREE.MeshStandardMaterial({ color: 0x8e8e8e })), previewSrc };
        this.materialCache.set(key, visual);
        return visual;
    }

    normalizeEntryFaces(blockDefinition, entry) {
        const fallbackId = this.normalizeBlockName(entry.name);
        const baseTextures = blockDefinition?.textures ?? fallbackId;
        const baseMap = normalizeTextureMap(baseTextures, fallbackId);
        const withAxis = applyAxisOrientation(baseMap, entry.states?.pillar_axis ?? entry.states?.axis);
        const facing = resolveFacing(entry.states);
        return rotateHorizontalFaces(withAxis, facing);
    }

    createMaterial(texture, renderMethod = 'opaque') {
        // If the texture is missing or not decoded into an image, return a neutral fallback material
        if (!texture || !texture.image) {
            console.warn('createMaterial: texture missing or has no image, using fallback material.', texture?.userData?.sourcePath || null);
            return new THREE.MeshStandardMaterial({ color: 0x8e8e8e });
        }

        const materialOptions = {
            map: texture,
            transparent: renderMethod !== 'opaque',
            alphaTest: renderMethod === 'alpha_test' ? 0.5 : 0,
            depthWrite: renderMethod !== 'blend',
            side: renderMethod === 'double_sided' ? THREE.DoubleSide : THREE.FrontSide,
        };

        if (renderMethod === 'blend') {
            materialOptions.blending = THREE.NormalBlending;
            materialOptions.depthWrite = false;
        }

        return new THREE.MeshStandardMaterial(materialOptions);
    }

    getFallbackVisual() {
        if (!this.fallbackVisual) {
            const fallbackMaterial = new THREE.MeshStandardMaterial({ color: 0x8e8e8e });
            this.fallbackVisual = {
                materials: Array(6).fill(fallbackMaterial),
                previewSrc: '',
            };
        }
        return this.fallbackVisual;
    }

    async getBlockPreview(blockName) {
        if (this.previewCache.has(blockName)) {
            return this.previewCache.get(blockName);
        }
        const visual = await this.getBlockVisual({ name: blockName, states: {} });
        this.previewCache.set(blockName, visual.previewSrc);
        return visual.previewSrc;
    }

    async readTextFile(path) {
        if (this.sourceMode === 'zip') {
            const file = await this.findZipEntry(path);
            if (!file) {
                throw new Error(`Missing file in resource pack: ${path}`);
            }
            return file.async('text');
        }
        const url = `${this.basePath}/${path.replace(/^\.\//, '')}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Unable to load ${path} from resource pack.`);
        }
        return res.text();
    }

    async findZipEntry(path) {
        if (!this.zip) return null;
        const normalized = path.replace(/^\.\//, '').toLowerCase();
        if (this.zipLookupCache.has(normalized)) {
            const cachedKey = this.zipLookupCache.get(normalized);
            return this.zip.files[cachedKey] || null;
        }

        const direct = this.zip.files[normalized];
        if (direct && !direct.dir) {
            this.zipLookupCache.set(normalized, normalized);
            return direct;
        }

        const matchKey = Object.keys(this.zip.files).find((key) => {
            const entry = this.zip.files[key];
            return !entry.dir && key.toLowerCase().endsWith(normalized);
        });

        if (matchKey) {
            this.zipLookupCache.set(normalized, matchKey);
            return this.zip.files[matchKey];
        }
        return null;
    }
}

