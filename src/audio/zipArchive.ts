const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

async function crc32Blob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i += 1) {
        crc = CRC32_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

function makeHeader(size: number): DataView {
  return new DataView(new ArrayBuffer(size));
}

export interface ZipEntry {
  name: string;
  blob: Blob;
}

/** Builds a standards-compliant ZIP using STORE (no compression), without loading file bodies into one giant ArrayBuffer. */
export async function createStoredZip(entries: ZipEntry[]): Promise<Blob> {
  if (!entries.length) throw new Error('Não há ficheiros para colocar no pacote ZIP.');
  if (entries.length > 32) throw new Error('O pacote ZIP excede o número seguro de ficheiros.');

  const parts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const stamp = dosDateTime(new Date());

  for (const entry of entries) {
    const safeName = entry.name.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_');
    const nameBytes = new TextEncoder().encode(safeName);
    if (nameBytes.length === 0 || nameBytes.length > 240) throw new Error('Nome de ficheiro inválido no pacote ZIP.');
    const size = entry.blob.size;
    if (!Number.isSafeInteger(size) || size > 0xffffffff) throw new Error('Um dos ficheiros é demasiado grande para este pacote ZIP.');
    const crc = await crc32Blob(entry.blob);

    const local = makeHeader(30);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const central = makeHeader(46);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, stamp.time, true);
    central.setUint16(14, stamp.date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), nameBytes, entry.blob);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + size;
    if (offset > 0xffffffff) throw new Error('O pacote ZIP ultrapassa o limite de tamanho suportado.');
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) {
    parts.push(part);
    centralSize += part.byteLength;
  }

  const end = makeHeader(22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true);
  parts.push(new Uint8Array(end.buffer));

  return new Blob(parts, { type: 'application/zip' });
}
