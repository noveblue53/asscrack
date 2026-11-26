// Pure-JS ISO/IEC 18004 QR Code Model 2 generator (Byte mode, Error Correction Level M, Versions 1-10).
// Produces a boolean matrix and crisp SVG markup for desktop pairing QR codes.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Compute Reed-Solomon generator polynomial coefficients for `ecCount` error correction codewords.
 */
export function rsGenerator(ecCount) {
    let poly = [1];
    for (let i = 0; i < ecCount; i++) {
        const next = new Array(poly.length + 1).fill(0);
        const factor = GF_EXP[i];
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= gfMul(poly[j], factor);
        }
        poly = next;
    }
    return poly;
}

export function rsEncode(data, ecCount) {
    const gen = rsGenerator(ecCount);
    const work = new Uint8Array(data.length + ecCount);
    work.set(data);
    for (let i = 0; i < data.length; i++) {
        const coef = work[i];
        if (coef === 0) continue;
        for (let j = 1; j < gen.length; j++) {
            work[i + j] ^= gfMul(gen[j], coef);
        }
    }
    return work.slice(data.length);
}

// EC Level M specs for Versions 1..10:
// capacity: max Byte-mode payload bytes
// blocks: array of [dataCodewords, ecCodewords]
// align: alignment pattern center coordinates
// rem: remainder bits
const VERSION_SPECS = [
    null,
    { version: 1, capacity: 14, blocks: [[16, 10]], align: [], rem: 0 },
    { version: 2, capacity: 26, blocks: [[28, 16]], align: [6, 18], rem: 7 },
    { version: 3, capacity: 42, blocks: [[44, 26]], align: [6, 22], rem: 7 },
    { version: 4, capacity: 62, blocks: [[32, 18], [32, 18]], align: [6, 26], rem: 7 },
    { version: 5, capacity: 84, blocks: [[43, 24], [43, 24]], align: [6, 30], rem: 7 },
    { version: 6, capacity: 106, blocks: [[27, 16], [27, 16], [27, 16], [27, 16]], align: [6, 34], rem: 7 },
    { version: 7, capacity: 122, blocks: [[31, 18], [31, 18], [31, 18], [31, 18]], align: [6, 22, 38], rem: 0 },
    { version: 8, capacity: 152, blocks: [[38, 22], [38, 22], [39, 22], [39, 22]], align: [6, 24, 42], rem: 0 },
    { version: 9, capacity: 180, blocks: [[36, 22], [36, 22], [36, 22], [37, 22], [37, 22]], align: [6, 26, 46], rem: 0 },
    { version: 10, capacity: 213, blocks: [[43, 26], [43, 26], [43, 26], [43, 26], [44, 26]], align: [6, 28, 50], rem: 0 }
];

function selectSpec(byteLen) {
    for (let v = 1; v < VERSION_SPECS.length; v++) {
        if (byteLen <= VERSION_SPECS[v].capacity) return VERSION_SPECS[v];
    }
    throw new RangeError(`QR payload too long (${byteLen} bytes, max ${VERSION_SPECS[10].capacity})`);
}

function encodeDataCodewords(bytes, spec) {
    const totalData = spec.blocks.reduce((sum, b) => sum + b[0], 0);
    const bits = [];
    const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    // Byte mode indicator (0100) + character count (8 bits for v1..9, 16 bits for v10+)
    pushBits(0b0100, 4);
    pushBits(bytes.length, spec.version >= 10 ? 16 : 8);
    for (const b of bytes) pushBits(b, 8);

    const maxBits = totalData * 8;
    const term = Math.min(4, maxBits - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        out.push(byte);
    }
    const padBytes = [0xec, 0x11];
    let p = 0;
    while (out.length < totalData) {
        out.push(padBytes[p % 2]);
        p++;
    }
    return Uint8Array.from(out);
}

function interleaveBlocks(dataBytes, spec) {
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (const [dataLen, ecLen] of spec.blocks) {
        const block = dataBytes.subarray(offset, offset + dataLen);
        offset += dataLen;
        dataBlocks.push(block);
        ecBlocks.push(rsEncode(block, ecLen));
    }

    const out = [];
    const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
    for (let i = 0; i < maxDataLen; i++) {
        for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    }
    const maxEcLen = Math.max(...ecBlocks.map(b => b.length));
    for (let i = 0; i < maxEcLen; i++) {
        for (const b of ecBlocks) if (i < b.length) out.push(b[i]);
    }
    return out;
}

function formatBits(maskPattern) {
    // EC Level M = 00 -> 5-bit data = (00 << 3) | maskPattern
    const data = maskPattern & 0x7;
    let rem = data << 10;
    const gen = 0x537;
    for (let i = 14; i >= 10; i--) {
        if ((rem >>> i) & 1) rem ^= gen << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
    let rem = version << 12;
    const gen = 0x1f25;
    for (let i = 17; i >= 12; i--) {
        if ((rem >>> i) & 1) rem ^= gen << (i - 12);
    }
    return (version << 12) | rem;
}

function buildMatrix(spec, codewords) {
    const size = spec.version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, dark) => {
        if (r < 0 || r >= size || c < 0 || c >= size) return;
        modules[r][c] = dark ? 1 : 0;
        isFunc[r][c] = 1;
    };

    const drawFinder = (top, left) => {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const rr = top + r;
                const cc = left + c;
                if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
                const inBox = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                const dark = inBox && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
                setFunc(rr, cc, dark);
            }
        }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
        setFunc(6, i, i % 2 === 0);
        setFunc(i, 6, i % 2 === 0);
    }

    const align = spec.align;
    for (const r of align) {
        for (const c of align) {
            if (isFunc[r][c]) continue;
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                    setFunc(r + dr, c + dc, dark);
                }
            }
        }
    }

    // Dark module
    setFunc(4 * spec.version + 9, 8, true);

    // Reserve format areas
    for (let i = 0; i < 9; i++) {
        if (i !== 6) {
            setFunc(8, i, false);
            setFunc(i, 8, false);
        }
    }
    for (let i = 0; i < 8; i++) {
        setFunc(8, size - 1 - i, false);
        if (i < 7) setFunc(size - 1 - i, 8, false);
    }

    // Version info for v7+
    if (spec.version >= 7) {
        const vb = versionBits(spec.version);
        for (let i = 0; i < 18; i++) {
            const bit = ((vb >>> i) & 1) === 1;
            const a = Math.floor(i / 3);
            const b = size - 11 + (i % 3);
            setFunc(a, b, bit);
            setFunc(b, a, bit);
        }
    }

    // Place data + EC bits in zigzag
    const allBits = [];
    for (const byte of codewords) {
        for (let b = 7; b >= 0; b--) allBits.push((byte >>> b) & 1);
    }
    for (let i = 0; i < spec.rem; i++) allBits.push(0);

    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col >= 1; col -= 2) {
        if (col === 6) col--;
        for (let step = 0; step < size; step++) {
            const r = upward ? size - 1 - step : step;
            for (let dc = 0; dc < 2; dc++) {
                const c = col - dc;
                if (isFunc[r][c]) continue;
                modules[r][c] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            }
        }
        upward = !upward;
    }

    return { size, modules, isFunc };
}

function applyMask(size, modules, isFunc, maskId) {
    const out = modules.map(row => new Uint8Array(row));
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (isFunc[r][c]) continue;
            let invert = false;
            switch (maskId) {
                case 0: invert = (r + c) % 2 === 0; break;
                case 1: invert = r % 2 === 0; break;
                case 2: invert = c % 3 === 0; break;
                case 3: invert = (r + c) % 3 === 0; break;
                case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
                case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
                case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
                case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
            }
            if (invert) out[r][c] ^= 1;
        }
    }
    const fmt = formatBits(maskId);
    for (let i = 0; i < 15; i++) {
        const bit = (fmt >>> i) & 1;
        if (i < 6) out[8][i] = bit;
        else if (i < 8) out[8][i + 1] = bit;
        else out[8][size - 15 + i] = bit;

        if (i < 7) out[size - 1 - i][8] = bit;
        else if (i === 7) out[8][8] = bit;
        else if (i === 8) out[7][8] = bit;
        else out[14 - i][8] = bit;
    }
    return out;
}

function penaltyScore(size, mat) {
    let score = 0;
    // 1. Runs of 5+ same-color modules
    for (let r = 0; r < size; r++) {
        let run = 1;
        for (let c = 1; c < size; c++) {
            if (mat[r][c] === mat[r][c - 1]) run++;
            else {
                if (run >= 5) score += run - 2;
                run = 1;
            }
        }
        if (run >= 5) score += run - 2;
    }
    for (let c = 0; c < size; c++) {
        let run = 1;
        for (let r = 1; r < size; r++) {
            if (mat[r][c] === mat[r - 1][c]) run++;
            else {
                if (run >= 5) score += run - 2;
                run = 1;
            }
        }
        if (run >= 5) score += run - 2;
    }
    // 2. 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
        for (let c = 0; c < size - 1; c++) {
            const v = mat[r][c];
            if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
        }
    }
    // 3. Finder-like 1:1:3:1:1 patterns
    const checkLine = get => {
        for (let i = 0; i <= size - 11; i++) {
            const matchA =
                get(i) === 1 && get(i + 1) === 0 && get(i + 2) === 1 && get(i + 3) === 1 && get(i + 4) === 1 &&
                get(i + 5) === 0 && get(i + 6) === 1 && get(i + 7) === 0 && get(i + 8) === 0 && get(i + 9) === 0 && get(i + 10) === 0;
            const matchB =
                get(i) === 0 && get(i + 1) === 0 && get(i + 2) === 0 && get(i + 3) === 0 && get(i + 4) === 1 &&
                get(i + 5) === 0 && get(i + 6) === 1 && get(i + 7) === 1 && get(i + 8) === 1 && get(i + 9) === 0 && get(i + 10) === 1;
            if (matchA || matchB) score += 40;
        }
    };
    for (let r = 0; r < size; r++) checkLine(c => mat[r][c]);
    for (let c = 0; c < size; c++) checkLine(r => mat[r][c]);
    // 4. Dark module balance
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mat[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
}

/**
 * Encode UTF-8 text as a QR Code Model 2 boolean matrix (EC Level M).
 */
export function encodeQrMatrix(text) {
    const bytes = Buffer.from(String(text ?? ''), 'utf8');
    const spec = selectSpec(bytes.length);
    const data = encodeDataCodewords(bytes, spec);
    const codewords = interleaveBlocks(data, spec);
    const { size, modules, isFunc } = buildMatrix(spec, codewords);

    let bestMask = 0;
    let bestScore = Infinity;
    let bestMat = null;
    for (let m = 0; m < 8; m++) {
        const candidate = applyMask(size, modules, isFunc, m);
        const s = penaltyScore(size, candidate);
        if (s < bestScore) {
            bestScore = s;
            bestMask = m;
            bestMat = candidate;
        }
    }

    return {
        version: spec.version,
        size,
        mask: bestMask,
        modules: bestMat.map(row => Array.from(row, v => v === 1))
    };
}

/**
 * Render UTF-8 text as a self-contained crisp QR code SVG string.
 */
export function renderQrSvg(text, { quietZone = 4 } = {}) {
    const { size, modules } = encodeQrMatrix(text);
    const total = size + quietZone * 2;
    const parts = [];
    for (let r = 0; r < size; r++) {
        let c = 0;
        while (c < size) {
            if (!modules[r][c]) { c++; continue; }
            const start = c;
            while (c < size && modules[r][c]) c++;
            parts.push(`M${start + quietZone},${r + quietZone}h${c - start}v1h-${c - start}z`);
        }
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
        `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
        `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
        `<path d="${parts.join('')}" fill="#000000"/>` +
        `</svg>`
    );
}
