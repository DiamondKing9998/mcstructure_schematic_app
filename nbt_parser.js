// NBT Parsing Logic Module
// Dependencies: pako (via CDN in index.html), NBT module (via nbt.min.js)

import { NBT } from './nbt.min.js';

/**
 * Core function to handle binary structure parsing (Gzip decompression and NBT parsing).
 * @param {ArrayBuffer} buffer - The raw file content as an ArrayBuffer.
 * @returns {Promise<object>} Resolves with the structure data, or throws an error.
 */
const GZIP_MAGIC_BYTES = [0x1f, 0x8b];

function isGzipCompressed(buffer) {
    // guard for very small/invalid buffers
    if (!buffer || (typeof buffer.byteLength === 'number' && buffer.byteLength < 2)) return false;
    const bytes = new Uint8Array(buffer.slice(0, 2));
    return bytes[0] === GZIP_MAGIC_BYTES[0] && bytes[1] === GZIP_MAGIC_BYTES[1];
}

export async function parseMCStructureBinary(buffer) {
    console.log("--- NBT Parser: Starting File Integrity Check ---");
    let decompressedData;
    let parsedStructureData;

    const looksGzipped = isGzipCompressed(buffer);

    if (looksGzipped) {
        // prefer globalThis to be robust in module contexts
        const pakoGlobal = (typeof globalThis !== 'undefined' ? globalThis.pako : (typeof window !== 'undefined' ? window.pako : null));
        if (!pakoGlobal || typeof pakoGlobal.inflate !== 'function') {
            throw new Error("Pako library (Gzip decompressor) is required but not loaded. Ensure pako is included (e.g. pako.min.js) and available on the page as global 'pako'.");
        }

        console.log("Step 1: Gzip signature detected. Attempting decompression...");
        try {
            const compressedData = new Uint8Array(buffer);
            decompressedData = pakoGlobal.inflate(compressedData);
            console.log(`NBT Parser: Gzip Decompression Success. Decompressed size: ${decompressedData.length} bytes.`);
        } catch (e) {
            console.error("NBT Parser: Gzip Decompression Failed.", e);
            throw new Error(`Gzip Decompression Error: Cannot decompress file. It may be corrupted or not a valid Gzip structure. (${e.message})`);
        }
    } else {
        console.log("Step 1: No Gzip signature detected. Treating file as already-decompressed Bedrock structure.");
        decompressedData = new Uint8Array(buffer);
    }

    console.log("Step 2: Attempting NBT Binary Parsing (Including Header Check)...");
    try {
        // NBT.parse may be sync or return a Promise depending on the implementation.
        let maybe = NBT.parse(decompressedData);
        if (maybe && typeof maybe.then === 'function') {
            parsedStructureData = await maybe;
        } else {
            parsedStructureData = maybe;
        }
    } catch (e) {
        // Try a tolerant fallback (some parsers expect an ArrayBuffer or a different typed view)
        try {
            let altInput = decompressedData instanceof Uint8Array ? decompressedData.buffer : decompressedData;
            let maybeAlt = NBT.parse(altInput);
            if (maybeAlt && typeof maybeAlt.then === 'function') {
                parsedStructureData = await maybeAlt;
            } else {
                parsedStructureData = maybeAlt;
            }
        } catch (e2) {
            console.error("NBT Parser: NBT Parsing Failed.", e, e2);
            throw new Error(`NBT Parsing Error: Failed to read Minecraft NBT structure data. The file format seems invalid after integrity checks. (${e.message || e2.message})`);
        }
    }

    console.log("--- NBT Parser: All Integrity Checks Passed! ---");
    // Debug: print top-level keys and structure
    if (parsedStructureData && typeof parsedStructureData === 'object') {
        console.log('[DEBUG] Top-level keys:', Object.keys(parsedStructureData));
        if (parsedStructureData.structure) {
            console.log('[DEBUG] structure keys:', Object.keys(parsedStructureData.structure));
            if (parsedStructureData.structure.block_indices) {
                const bi = parsedStructureData.structure.block_indices;
                console.log('[DEBUG] block_indices type:', typeof bi, 'keys:', Object.keys(bi), 'length:', bi.length);
                // Print a sample of the first block_indices entry
                const firstKey = Object.keys(bi)[0];
                if (firstKey) {
                    console.log(`[DEBUG] block_indices[${firstKey}] sample:`, Array.isArray(bi[firstKey]) ? bi[firstKey].slice(0, 20) : bi[firstKey]);
                }
            }
        }
    }
    const transformed = transformStructure(parsedStructureData);
    // Debug logging for troubleshooting
    console.log("[DEBUG] Parsed palette:", transformed.palette);
    console.log("[DEBUG] Block count:", transformed.blocks.length);
    console.log("[DEBUG] Material counts:", transformed.materials);
    return transformed;
}

function normalizeSize(sizeList = []) {
    return {
        x: Number(sizeList[0] ?? 0),
        y: Number(sizeList[1] ?? 0),
        z: Number(sizeList[2] ?? 0),
    };
}

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return Number(value ?? 0);
}

function buildMaterialCounts(structureSection, palette) {
    if (!structureSection) {
        return {};
    }

    const paletteNames = palette.map((entry) => (entry?.name ?? 'minecraft:unknown').toLowerCase());
    const counts = Object.create(null);
    const blockIndexLayers = structureSection.block_indices ?? [];

    blockIndexLayers.forEach((layer) => {
        if (!Array.isArray(layer)) return;
        layer.forEach((rawIndex) => {
            const index = toNumber(rawIndex);
            if (!Number.isFinite(index) || index < 0 || index >= paletteNames.length) {
                return;
            }
            const blockName = paletteNames[index];
            if (!blockName || blockName === 'minecraft:air') {
                return;
            }
            counts[blockName] = (counts[blockName] || 0) + 1;
        });
    });

    return counts;
}

function buildPalette(structureSection) {
    const rawPalette = structureSection.palette?.default?.block_palette ?? [];
    return rawPalette.map((entry, index) => ({
        index,
        name: entry?.name ?? 'minecraft:unknown',
        states: entry?.states ?? {},
        version: entry?.version ?? 0,
    }));
}

function buildBlocks(structureSection, size, paletteLength) {
    // block_indices is an array of layers (each layer is a flattened X*Z plane) -- iterate every layer
    const blockIndices = structureSection.block_indices ?? [];
    const areaXZ = size.x * size.z;
    const blocks = [];

    // Support both array and object (Bedrock format)
    let layers = [];
    if (Array.isArray(blockIndices)) {
        layers = blockIndices.map((layer, i) => ({ y: i, data: layer }));
    } else if (typeof blockIndices === 'object' && blockIndices !== null) {
        // Object with string keys for Y layers
        layers = Object.keys(blockIndices)
            .map(k => ({ y: parseInt(k, 10), data: blockIndices[k] }))
            .sort((a, b) => a.y - b.y);
    }

    // Debug: log number of layers and expected Y size
    console.log(`[DEBUG] buildBlocks: block_indices layers: ${layers.length}, expected Y size: ${size.y}`);

    for (const { y, data: layer } of layers) {
        if (!Array.isArray(layer)) continue;
        const limit = Math.min(layer.length, areaXZ);
        for (let idx = 0; idx < limit; idx++) {
            const paletteIndex = toNumber(layer[idx]);
            if (!Number.isFinite(paletteIndex) || paletteIndex < 0 || paletteIndex >= paletteLength) {
                continue;
            }
            const z = Math.floor(idx / size.x);
            const x = idx % size.x;
            blocks.push({ x, y, z, paletteIndex });
        }
    }

    return blocks;
}

function transformStructure(rootCompound) {
    const size = normalizeSize(rootCompound.size);
    const structureSection = rootCompound.structure ?? {};
    const palette = buildPalette(structureSection);
    const materials = buildMaterialCounts(structureSection, palette);
    const blocks = buildBlocks(structureSection, size, palette.length);

    return {
        size,
        palette,
        materials,
        blocks,
        raw: rootCompound,
    };
}