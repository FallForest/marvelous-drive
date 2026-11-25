import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ZIP32_COUNT_LIMIT, ZIP32_LIMIT, ZIP64_VERSION, zip64Extra, zipDataDescriptor, zipEndRecords,
} from '../src/text/zip-records.js'

/**
 * These records only differ from their classic form once an archive exceeds
 * ZIP32, which is far too large to build in a test. The writers take plain
 * numbers, so the overflow boundaries, record layouts, and sentinel fields can
 * be asserted directly without materialising multi-gigabyte buffers.
 */

const SIG_DATA_DESCRIPTOR = 0x08074b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50

const ZIP64_EOCD_BYTES = 56
const ZIP64_LOCATOR_BYTES = 20
const EOCD_BYTES = 22
const ZIP64_TAIL_BYTES = ZIP64_EOCD_BYTES + ZIP64_LOCATOR_BYTES + EOCD_BYTES

const GIB = 1024 ** 3
const FIVE_GIB = 5 * GIB
/** One past the largest value a 32-bit ZIP field can hold. */
const UINT32_PLUS_ONE = 0x100000000

/** Splits the three-record ZIP64 tail so each record can be checked by offset. */
function splitZip64Tail(tail) {
  assert.equal(tail.length, ZIP64_TAIL_BYTES)
  return {
    zip64: tail.subarray(0, ZIP64_EOCD_BYTES),
    locator: tail.subarray(ZIP64_EOCD_BYTES, ZIP64_EOCD_BYTES + ZIP64_LOCATOR_BYTES),
    classic: tail.subarray(ZIP64_EOCD_BYTES + ZIP64_LOCATOR_BYTES),
  }
}

describe('ZIP64 constants', () => {
  it('matches the sentinel values and extraction version from APPNOTE', () => {
    assert.equal(ZIP32_LIMIT, 0xffffffff)
    assert.equal(ZIP32_COUNT_LIMIT, 0xffff)
    assert.equal(ZIP64_VERSION, 45)
  })
})

describe('zipDataDescriptor', () => {
  it('keeps the classic 16-byte descriptor for small values', () => {
    const descriptor = zipDataDescriptor(0x12345678, 4096)

    assert.equal(descriptor.length, 16)
    assert.equal(descriptor.readUInt32LE(0), SIG_DATA_DESCRIPTOR)
    assert.equal(descriptor.readUInt32LE(4), 0x12345678)
    assert.equal(descriptor.readUInt32LE(8), 4096)
    assert.equal(descriptor.readUInt32LE(12), 4096)
  })

  it('writes both lengths as uint64 for a size above 4 GiB', () => {
    const crc = 0xdeadbeef
    const size = FIVE_GIB + 123
    const descriptor = zipDataDescriptor(crc, size)

    assert.equal(descriptor.length, 24)
    assert.equal(descriptor.readUInt32LE(0), SIG_DATA_DESCRIPTOR)
    assert.equal(descriptor.readUInt32LE(4), crc)
    assert.equal(descriptor.readBigUInt64LE(8), BigInt(size))
    assert.equal(descriptor.readBigUInt64LE(16), BigInt(size))
  })

  it('widens at the ZIP32 sentinel itself, not one byte beyond it', () => {
    const classic = zipDataDescriptor(0, ZIP32_LIMIT - 1)
    assert.equal(classic.length, 16)
    assert.equal(classic.readUInt32LE(8), ZIP32_LIMIT - 1)

    const wide = zipDataDescriptor(0, ZIP32_LIMIT)
    assert.equal(wide.length, 24)
    assert.equal(wide.readBigUInt64LE(8), BigInt(ZIP32_LIMIT))
  })
})

describe('zip64Extra', () => {
  it('returns no extra field when nothing overflows', () => {
    assert.equal(zip64Extra([]).length, 0)
  })

  it('writes values in order in one 0x0001 extra, including a >4 GiB offset', () => {
    // The caller supplies APPNOTE fields in order: uncompressed, compressed,
    // local header offset. The last one is the value that overflowed ZIP32.
    const values = [0x1000, 0x2000, UINT32_PLUS_ONE + 7]
    const extra = zip64Extra(values)

    assert.equal(extra.length, 4 + values.length * 8)
    assert.equal(extra.readUInt16LE(0), 0x0001)
    assert.equal(extra.readUInt16LE(2), values.length * 8)
    assert.equal(extra.readBigUInt64LE(4), BigInt(values[0]))
    assert.equal(extra.readBigUInt64LE(12), BigInt(values[1]))
    assert.equal(extra.readBigUInt64LE(20), BigInt(values[2]))
  })
})

describe('zipEndRecords', () => {
  it('writes only the classic 22-byte EOCD while every value fits', () => {
    const end = zipEndRecords(3, 512, 1024)

    assert.equal(end.length, EOCD_BYTES)
    assert.equal(end.readUInt32LE(0), SIG_EOCD)
    assert.equal(end.readUInt16LE(4), 0)
    assert.equal(end.readUInt16LE(6), 0)
    assert.equal(end.readUInt16LE(8), 3)
    assert.equal(end.readUInt16LE(10), 3)
    assert.equal(end.readUInt32LE(12), 512)
    assert.equal(end.readUInt32LE(16), 1024)
    assert.equal(end.readUInt16LE(20), 0)
  })

  it('writes the ZIP64 EOCD and locator for a count of exactly 65535', () => {
    const entryCount = ZIP32_COUNT_LIMIT
    const centralSize = 700000
    const centralStart = 123456
    const { zip64, locator, classic } = splitZip64Tail(zipEndRecords(entryCount, centralSize, centralStart))

    assert.equal(zip64.readUInt32LE(0), SIG_ZIP64_EOCD)
    assert.equal(zip64.readBigUInt64LE(4), 44n)
    assert.equal(zip64.readUInt16LE(12), ZIP64_VERSION)
    assert.equal(zip64.readUInt16LE(14), ZIP64_VERSION)
    assert.equal(zip64.readUInt32LE(16), 0)
    assert.equal(zip64.readUInt32LE(20), 0)
    assert.equal(zip64.readBigUInt64LE(24), BigInt(entryCount))
    assert.equal(zip64.readBigUInt64LE(32), BigInt(entryCount))
    assert.equal(zip64.readBigUInt64LE(40), BigInt(centralSize))
    assert.equal(zip64.readBigUInt64LE(48), BigInt(centralStart))

    assert.equal(locator.readUInt32LE(0), SIG_ZIP64_LOCATOR)
    assert.equal(locator.readUInt32LE(4), 0)
    assert.equal(locator.readBigUInt64LE(8), BigInt(centralStart + centralSize))
    assert.equal(locator.readUInt32LE(16), 1)

    assert.equal(classic.readUInt32LE(0), SIG_EOCD)
    assert.equal(classic.readUInt16LE(8), 0xffff)
    assert.equal(classic.readUInt16LE(10), 0xffff)
    assert.equal(classic.readUInt32LE(12), centralSize)
    assert.equal(classic.readUInt32LE(16), centralStart)
  })

  it('writes the ZIP64 EOCD and locator when the directory starts past UINT32', () => {
    const entryCount = 7
    const centralSize = 4096
    const centralStart = UINT32_PLUS_ONE + 1024
    const { zip64, locator, classic } = splitZip64Tail(zipEndRecords(entryCount, centralSize, centralStart))

    assert.equal(zip64.readBigUInt64LE(24), BigInt(entryCount))
    assert.equal(zip64.readBigUInt64LE(40), BigInt(centralSize))
    assert.equal(zip64.readBigUInt64LE(48), BigInt(centralStart))

    assert.equal(locator.readBigUInt64LE(8), BigInt(centralStart + centralSize))

    assert.equal(classic.readUInt16LE(8), entryCount)
    assert.equal(classic.readUInt16LE(10), entryCount)
    assert.equal(classic.readUInt32LE(12), centralSize)
    assert.equal(classic.readUInt32LE(16), 0xffffffff)
  })

  it('sentinels the central size when only that field overflows UINT32', () => {
    const entryCount = 9
    const centralSize = UINT32_PLUS_ONE + 2048
    const centralStart = 2048
    const { zip64, locator, classic } = splitZip64Tail(zipEndRecords(entryCount, centralSize, centralStart))

    assert.equal(zip64.readBigUInt64LE(24), BigInt(entryCount))
    assert.equal(zip64.readBigUInt64LE(40), BigInt(centralSize))
    assert.equal(zip64.readBigUInt64LE(48), BigInt(centralStart))

    assert.equal(locator.readBigUInt64LE(8), BigInt(centralStart + centralSize))

    assert.equal(classic.readUInt16LE(8), entryCount)
    assert.equal(classic.readUInt16LE(10), entryCount)
    assert.equal(classic.readUInt32LE(12), 0xffffffff)
    assert.equal(classic.readUInt32LE(16), centralStart)
  })
})
