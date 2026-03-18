import { createHash } from "node:crypto";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface ParsedWebSocketFrame {
  opcode: number;
  payload: Buffer;
}

export function createWebSocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_MAGIC_GUID}`).digest("base64");
}

export function encodeWebSocketTextFrame(text: string): Buffer {
  return encodeWebSocketFrame(Buffer.from(text, "utf8"), 0x1);
}

export function encodeWebSocketPongFrame(payload: Buffer): Buffer {
  return encodeWebSocketFrame(payload, 0xA);
}

export function parseWebSocketFrames(buffer: Buffer): { frames: ParsedWebSocketFrame[]; remaining: Buffer } {
  const frames: ParsedWebSocketFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    if (firstByte === undefined || secondByte === undefined) {
      break;
    }

    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      throw new Error("Large websocket frames are not supported in this bootstrap");
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) {
      break;
    }

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLength));

    if (masked) {
      const maskOffset = offset + headerLength;
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= buffer[maskOffset + (index % 4)] ?? 0;
      }
    }

    frames.push({
      opcode,
      payload,
    });
    offset += frameLength;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

function encodeWebSocketFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([
      Buffer.from([0x80 | opcode, length]),
      payload,
    ]);
  }

  const header = Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 126;
  header.writeUInt16BE(length, 2);
  return Buffer.concat([header, payload]);
}
