export class BinaryReader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.position = 0;
  }

  remaining() { return this.bytes.byteLength - this.position; }

  skip(length) { this.require(length); this.position += length; }

  readBytes(length) {
    this.require(length);
    const slice = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  readUnsignedByte() { this.require(1); return this.bytes[this.position++]; }

  readInt32() {
    this.require(4);
    const value = this.view.getInt32(this.position, true);
    this.position += 4;
    return value;
  }

  readUint32() {
    this.require(4);
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  readFixedAscii(length) {
    const bytes = this.readBytes(length);
    let end = 0;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder("latin1").decode(bytes.subarray(0, end));
  }

  require(length) {
    if (length < 0 || this.position + length > this.bytes.byteLength) {
      throw new Error("Unexpected end of binary data");
    }
  }
}
