// NBT Parsing Logic Module
// Dependencies: pako (via CDN in index.html), NBT (via nbt.min.js)

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

    if (typeof NBT === 'undefined' || !NBT.parse) {
        throw new Error("NBT parser library (nbt.min.js) is required but not loaded.");
    }

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
        parsedStructureData = NBT.parse(decompressedData.buffer);
    } catch (e) {
        console.error("NBT Parser: NBT Parsing Failed.", e);
        throw new Error(`NBT Parsing Error: Failed to read Minecraft NBT structure data. The file format seems invalid after integrity checks. (${e.message})`);
    }

    console.log("--- NBT Parser: All Integrity Checks Passed! ---");
    return parsedStructureData;
}


// MOCK_BLOCK_DATA is no longer needed here as the NBT.parse mock handles it.
// We export an empty object so the main module can still import MOCK_BLOCK_DATA without error.
export const MOCK_BLOCK_DATA = {};