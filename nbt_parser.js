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
    const bytes = new Uint8Array(buffer.slice(0, 2));
    return bytes[0] === GZIP_MAGIC_BYTES[0] && bytes[1] === GZIP_MAGIC_BYTES[1];
}

export async function parseMCStructureBinary(buffer) {
    console.log("--- NBT Parser: Starting File Integrity Check ---");
    let decompressedData;
    let parsedStructureData;

    const looksGzipped = isGzipCompressed(buffer);

    if (looksGzipped) {
        if (typeof pako === 'undefined' || !pako.inflate) {
            throw new Error("Pako library (Gzip decompressor) is required but not loaded.");
        }

        console.log("Step 1: Gzip signature detected. Attempting decompression...");
        try {
            const compressedData = new Uint8Array(buffer);
            decompressedData = pako.inflate(compressedData);
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
        parsedStructureData = NBT.parse(decompressedData);
    } catch (e) {
        console.error("NBT Parser: NBT Parsing Failed.", e);
        throw new Error(`NBT Parsing Error: Failed to read Minecraft NBT structure data. The file format seems invalid after integrity checks. (${e.message})`);
    }

    console.log("--- NBT Parser: All Integrity Checks Passed! ---");
    return transformStructure(parsedStructureData);
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
    const blockIndicesLayers = structureSection.block_indices ?? [];
    const primaryLayer = blockIndicesLayers[0] ?? [];
    const totalBlocks = size.x * size.y * size.z;
    const limit = Math.min(primaryLayer.length, totalBlocks);
    const areaXZ = size.x * size.z;
    const blocks = [];

    for (let idx = 0; idx < limit; idx++) {
        const paletteIndex = toNumber(primaryLayer[idx]);
        if (!Number.isFinite(paletteIndex) || paletteIndex <= 0 || paletteIndex >= paletteLength) {
            continue;
        }

        const y = Math.floor(idx / areaXZ);
        const rem = idx % areaXZ;
        const z = Math.floor(rem / size.x);
        const x = rem % size.x;

        blocks.push({ x, y, z, paletteIndex });
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