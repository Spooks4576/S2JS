// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// BFRES model reader: meshes, materials, skeleton and skeletal animations.

import { zstdDecompress } from "../compression/zstd-decode.js";
import { halfToFloat, mat4 } from "../util/math.js";
import { fail } from "../util/errors.js";

const BFRES_COMPONENTS = { 0x02: [1, 1], 0x09: [2, 1], 0x0b: [4, 1], 0x0a: [1, 2], 0x12: [2, 2], 0x15: [4, 2], 0x14: [1, 4], 0x17: [2, 4], 0x18: [3, 4], 0x19: [4, 4] };

const bfresAttribReader = (view, format) => {
  const layout = format >> 8;
  const type = format & 0xff;
  if (layout === 0x0e) {
    return (at) => {
      const v = view.getUint32(at, true);
      const part = (shift) => {
        const raw = (v >> shift) & 1023;
        return type === 2 ? Math.max(-1, (raw & 512 ? raw - 1024 : raw) / 511) : raw / 1023;
      };
      return [part(0), part(10), part(20), type === 2 ? ((v >>> 30) & 2 ? -1 : (v >>> 30) & 1) : (v >>> 30) / 3];
    };
  }
  const spec = BFRES_COMPONENTS[layout];
  if (!spec) return null;
  const [count, size] = spec;
  const one = (at) => {
    if (size === 1) {
      if (type === 1) return view.getUint8(at) / 255;
      if (type === 2) return Math.max(-1, view.getInt8(at) / 127);
      return type === 4 ? view.getInt8(at) : view.getUint8(at);
    }
    if (size === 2) {
      if (type === 5) return halfToFloat(view.getUint16(at, true));
      if (type === 1) return view.getUint16(at, true) / 65535;
      if (type === 2) return Math.max(-1, view.getInt16(at, true) / 32767);
      return type === 4 ? view.getInt16(at, true) : view.getUint16(at, true);
    }
    if (type === 5) return view.getFloat32(at, true);
    return type === 4 ? view.getInt32(at, true) : view.getUint32(at, true);
  };
  return (at) => {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = one(at + i * size);
    return out;
  };
};

const bfresQuaternion = ([x, y, z, w]) => [
  1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
  2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
  2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
  0, 0, 0, 1
];

const bfresEuler = ([x, y, z]) => {
  const deg = 180 / Math.PI;
  return mat4.mul(mat4.rotateAxis(2, z * deg), mat4.mul(mat4.rotateAxis(1, y * deg), mat4.rotateAxis(0, x * deg)));
};

const BFRES_ROLES = [
  ["map", /^_a\d|albedo|^_alb|basecolor|diffuse/i, /_alb(edo)?\d*$|_col$|_diff?$|_bc$/i],
  ["normalMap", /^_n\d|normal/i, /_nrm\d*$|_nor$|_normal$/i],
  ["specularMap", /^_s\d|specular/i, /_spm?$|_spec(ular)?$/i],
  ["emissiveMap", /^_e\d|emissi/i, /_emm?$|_emi(ssive)?$|_glow$/i],
  ["aoMap", /^_occ\d|^_ao\d|occlusion/i, /_occ$|_ao$/i]
];

const bfresLocal = (scale, rotation, translation, euler) =>
  mat4.mul(mat4.mul(mat4.translate(translation), euler ? bfresEuler(rotation) : bfresQuaternion(rotation)), mat4.scale(scale));

const BFRES_ANIM_TARGETS = { 0x04: 0, 0x08: 1, 0x0c: 2, 0x10: 7, 0x14: 8, 0x18: 9, 0x20: 3, 0x24: 4, 0x28: 5, 0x2c: 6 };

const readBfresAnimations = (bytes, view, str, u64, u16, u32, tag) => {
  const array = u64(0x58);
  const count = u16(0xe2);
  const clips = [];
  for (let c = 0; c < count; c++) {
    const at = array + c * 0x50;
    if (tag(at) !== "FSKA") break;
    const flags = u32(at + 4);
    const boneArray = u64(at + 0x28);
    const boneCount = u16(at + 0x4c);
    const bones = [];
    for (let b = 0; b < boneCount; b++) {
      const bt = boneArray + b * 0x38;
      const bflags = u32(bt + 0x28);
      const base = u64(bt + 0x10);
      const values = {};
      let k = 0;
      const take = (comps) => comps.forEach((comp) => (values[comp] = view.getFloat32(base + 4 * k++, true)));
      if (base) {
        if (bflags & 0x08) take([0, 1, 2]);
        if (bflags & 0x10) take([3, 4, 5, 6]);
        if (bflags & 0x20) take([7, 8, 9]);
      }
      const curves = [];
      const curveArray = u64(bt + 0x08);
      for (let n = 0; n < bytes[bt + 0x2e]; n++) {
        const ct = curveArray + n * 0x30;
        const cflags = u16(ct + 0x10);
        const keyCount = u16(ct + 0x12);
        const comp = BFRES_ANIM_TARGETS[u32(ct + 0x14)];
        const frameType = cflags & 3;
        const keyType = (cflags >> 2) & 3;
        const curveType = (cflags >> 4) & 7;
        const scale = view.getFloat32(ct + 0x24, true);
        const offset = view.getFloat32(ct + 0x28, true);
        const hermite = (cflags & 0x4000) !== 0 && curveType === 0;
        const per = hermite ? 2 : curveType === 0 ? 4 : curveType === 1 ? 2 : 1;
        const frameAt = u64(ct);
        const keyAt = u64(ct + 0x08);
        const frames = new Float32Array(keyCount);
        for (let i = 0; i < keyCount; i++) frames[i] = frameType === 0 ? view.getFloat32(frameAt + i * 4, true) : frameType === 1 ? view.getInt16(frameAt + i * 2, true) / 32 : bytes[frameAt + i];
        const dataAt = hermite ? keyAt + 8 : keyAt;
        const slopeScale = hermite ? view.getFloat32(keyAt, true) : 0;
        const slopeOffset = hermite ? view.getFloat32(keyAt + 4, true) : 0;
        const keys = new Float32Array(keyCount * per);
        for (let i = 0; i < keyCount * per; i++) {
          const raw =
            keyType === 0
              ? view.getFloat32(dataAt + i * 4, true)
              : keyType === 1
                ? hermite
                  ? view.getUint16(dataAt + i * 2, true)
                  : view.getInt16(dataAt + i * 2, true)
                : hermite
                  ? view.getUint8(dataAt + i)
                  : view.getInt8(dataAt + i);
          if (hermite) keys[i] = i % 2 === 0 ? (keyType === 0 && scale === 0 ? raw : raw * scale + offset) : keyType === 0 && slopeScale === 0 ? raw : raw * slopeScale + slopeOffset;
          else keys[i] = keyType === 0 && scale === 0 ? raw : raw * scale + (i % per === 0 ? offset : 0);
        }
        if (comp !== undefined) curves.push({ comp, frames, keys, per, hermite, start: view.getFloat32(ct + 0x18, true), end: view.getFloat32(ct + 0x1c, true) });
      }
      bones.push({ name: str(u64(bt)), values, curves });
    }
    clips.push({ name: str(u64(at + 0x08)), frames: Math.max(1, u32(at + 0x40)), loop: !!(flags & 4), euler: (flags & 0x7000) === 0x1000, bones });
  }
  return clips;
};

const evalBfresCurve = (curve, frame) => {
  const { frames, keys, per } = curve;
  const n = frames.length;
  if (!n) return 0;
  if (frame <= frames[0]) return keys[0];
  let i = n - 1;
  while (i > 0 && frames[i] > frame) i--;
  if (i >= n - 1) return keys[(n - 1) * per];
  const span = frames[i + 1] - frames[i];
  const x = (frame - frames[i]) / (span || 1);
  const k = i * per;
  if (curve.hermite) {
    const x2 = x * x;
    const x3 = x2 * x;
    return (2 * x3 - 3 * x2 + 1) * keys[k] + (x3 - 2 * x2 + x) * span * keys[k + 1] + (-2 * x3 + 3 * x2) * keys[k + 2] + (x3 - x2) * span * keys[k + 3];
  }
  if (per === 4) return keys[k] + x * (keys[k + 1] + x * (keys[k + 2] + x * keys[k + 3]));
  if (per === 2) return keys[k] + keys[k + 1] * x;
  return keys[k];
};

const bfresLocalValues = (skeleton, clip, frame) => {
  const byName = new Map(clip.bones.map((b) => [b.name, b]));
  return skeleton.bones.map((bone) => {
    const anim = byName.get(bone.name);
    const v = [...bone.scale, ...bone.rotation, ...bone.translation];
    if (!anim) return { v, euler: bone.euler };
    let euler = bone.euler;
    if (anim.values[3] !== undefined || anim.curves.some((c) => c.comp >= 3 && c.comp <= 6)) euler = clip.euler;
    for (const [comp, value] of Object.entries(anim.values)) v[comp] = value;
    for (const curve of anim.curves) v[curve.comp] = evalBfresCurve(curve, frame);
    if (!euler) {
      const len = Math.hypot(v[3], v[4], v[5], v[6]) || 1;
      for (let c = 3; c < 7; c++) v[c] /= len;
    }
    return { v, euler };
  });
};

const bfresPose = (skeleton, clip, frame) => {
  const locals = bfresLocalValues(skeleton, clip, frame).map(({ v, euler }) => bfresLocal(v.slice(0, 3), v.slice(3, 7), v.slice(7, 10), euler));
  const worlds = [];
  const world = (i) => {
    if (worlds[i]) return worlds[i];
    const parent = skeleton.bones[i].parent;
    worlds[i] = parent < skeleton.bones.length && parent !== i ? mat4.mul(world(parent), locals[i]) : locals[i];
    return worlds[i];
  };
  return skeleton.bones.map((_, i) => mat4.mul(world(i), skeleton.inverse[i]));
};

const quatToEulerXYZ = ([x, y, z, w]) => {
  const m00 = 1 - 2 * (y * y + z * z);
  const m10 = 2 * (x * y + z * w);
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  return [Math.atan2(m21, m22), Math.asin(Math.max(-1, Math.min(1, -m20))), Math.atan2(m10, m00)];
};

const bfresTrs = (skeleton, clip, frame) =>
  (clip ? bfresLocalValues(skeleton, clip, frame) : skeleton.bones.map((b) => ({ v: [...b.scale, ...b.rotation, ...b.translation], euler: b.euler }))).map(({ v, euler }) => ({
    s: v.slice(0, 3),
    r: euler ? v.slice(3, 6) : quatToEulerXYZ(v.slice(3, 7)),
    t: v.slice(7, 10)
  }));

const readBfres = (buffer) => {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) bytes = zstdDecompress(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 0x100 || String.fromCharCode(...bytes.subarray(0, 8)) !== "FRES    ") fail("Not a Switch BFRES model");
  if (view.getUint16(0x0c, true) !== 0xfeff) fail("Big endian Wii U BFRES files are not supported");
  const version = view.getUint32(8, true);
  const label = `BFRES ${version >>> 24}.${(version >> 16) & 255}.${(version >> 8) & 255}.${version & 255}`;
  const u64 = (at) => Number(view.getBigUint64(at, true));
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  const str = (at) => {
    if (!at || at + 2 > bytes.length) return "";
    return text.decode(bytes.subarray(at + 2, at + 2 + u16(at)));
  };
  const dictNames = (at) => {
    if (!at) return [];
    const n = u32(at + 4);
    return Array.from({ length: n }, (_, i) => str(u64(at + 8 + 16 * (i + 1) + 8)));
  };
  const modelArray = u64(0x28);
  const modelCount = u16(0xdc);
  const animations = readBfresAnimations(bytes, view, str, u64, u16, u32, tag);
  if ((!modelCount || tag(modelArray) !== "FMDL") && !animations.length) fail(`${label} files are not supported yet`);
  const dataStart = modelCount ? u64(u64(0xb0) + 8) : 0;
  const meshes = [];
  let skeletonOut = null;

  for (let m = 0; m < modelCount; m++) {
    const model = modelArray + m * 0xa0;
    if (tag(model) !== "FMDL") break;
    const skeleton = u64(model + 0x18);
    const vbufArray = u64(model + 0x20);
    const shapeArray = u64(model + 0x28);
    const materialArray = u64(model + 0x38);
    const shapeCount = u16(model + 0x6a);
    const materialCount = u16(model + 0x6c);

    const boneArray = u64(skeleton + 0x10);
    const matrixToBone = u64(skeleton + 0x18);
    const boneCount = u16(skeleton + 0x38);
    const bones = Array.from({ length: boneCount }, (_, i) => {
      const at = boneArray + i * 0x58;
      const floats = (o, n) => Array.from({ length: n }, (_, k) => view.getFloat32(at + o + k * 4, true));
      const scale = floats(0x30, 3);
      const rotation = floats(0x3c, 4);
      const translation = floats(0x4c, 3);
      const euler = (u32(at + 0x2c) & 0x7000) === 0x1000;
      return { name: str(u64(at)), parent: u16(at + 0x22), scale, rotation, translation, euler, local: bfresLocal(scale, rotation, translation, euler) };
    });
    const matrixBone = (slot) => (matrixToBone ? u16(matrixToBone + slot * 2) : slot);
    const worlds = new Map();
    const world = (i) => {
      if (i >= bones.length) return mat4.identity();
      if (worlds.has(i)) return worlds.get(i);
      const b = bones[i];
      const w = b.parent < bones.length && b.parent !== i ? mat4.mul(world(b.parent), b.local) : b.local;
      worlds.set(i, w);
      return w;
    };

    const materials = Array.from({ length: materialCount }, (_, i) => {
      const at = materialArray + i * 0xb0;
      const name = str(u64(at + 0x08));
      const textureArray = u64(at + 0x20);
      const count = bytes[at + 0xa2];
      const samplers = dictNames(u64(at + 0x38));
      const out = { name, color: [1, 1, 1], map: null, alphaMap: null, normalMap: null, specularMap: null, emissiveMap: null, aoMap: null, shininess: 20, cutout: /cutout|alphatest|_at\b/i.test(name), blend: /xlu|translucen|transparen/i.test(name) };
      for (let t = 0; t < count; t++) {
        const file = str(u64(textureArray + t * 8));
        const sampler = samplers[t] || "";
        for (const [slot, bySampler, byName] of BFRES_ROLES) {
          if (out[slot]) continue;
          if (bySampler.test(sampler) || (!samplers.length && byName.test(file))) {
            out[slot] = { file, embedded: null, uv: slot === "aoMap" ? 1 : 0 };
            break;
          }
        }
      }
      if (!out.map) out.color = [0.8, 0.8, 0.8];
      if (out.blend && out.map) out.alphaMap = out.map;
      return out;
    });

    for (let s = 0; s < shapeCount; s++) {
      const shape = shapeArray + s * 0x60;
      if (tag(shape) !== "FSHP") break;
      const vbuf = u64(shape + 0x10);
      const meshArray = u64(shape + 0x18);
      const materialIndex = u16(shape + 0x52);
      const boneIndex = u16(shape + 0x54);
      const skinCount = bytes[shape + 0x5a];
      const meshCount = bytes[shape + 0x5b];
      if (!meshCount || tag(vbuf) !== "FVTX") continue;

      const attribArray = u64(vbuf + 0x08);
      const sizeArray = u64(vbuf + 0x30);
      const strideArray = u64(vbuf + 0x38);
      const bufferOffset = u32(vbuf + 0x48);
      const attribCount = bytes[vbuf + 0x4c];
      const bufferCount = bytes[vbuf + 0x4d];
      const starts = [];
      for (let b = 0, at = dataStart + bufferOffset; b < bufferCount; b++) {
        starts.push(at);
        at += Math.ceil(u32(sizeArray + b * 0x10) / 8) * 8;
      }
      const attribs = {};
      for (let a = 0; a < attribCount; a++) {
        const at = attribArray + a * 16;
        const buf = u16(at + 14);
        attribs[str(u64(at))] = { read: bfresAttribReader(view, u32(at + 8)), offset: u16(at + 12), start: starts[buf], stride: u32(strideArray + buf * 0x10) };
      }
      const get = (name, v) => {
        const a = attribs[name];
        return a?.read ? a.read(a.start + v * a.stride + a.offset) : null;
      };
      if (!attribs._p0?.read) continue;

      const mesh = meshArray;
      const faceOffset = u32(mesh + 0x20);
      const primitive = u32(mesh + 0x24);
      const indexFormat = u32(mesh + 0x28);
      const indexCount = u32(mesh + 0x2c);
      const firstVertex = u32(mesh + 0x30);
      const indexAt = dataStart + faceOffset;
      const index = (i) => firstVertex + (indexFormat === 0 ? bytes[indexAt + i] : indexFormat === 1 ? u16(indexAt + i * 2) : u32(indexAt + i * 4));
      let tris = [];
      if (primitive === 3) for (let i = 0; i + 2 < indexCount; i += 3) tris.push(index(i), index(i + 1), index(i + 2));
      else if (primitive === 4) {
        for (let i = 0; i + 2 < indexCount; i++) {
          const [a, b, c] = i & 1 ? [index(i + 1), index(i), index(i + 2)] : [index(i), index(i + 1), index(i + 2)];
          if (a !== b && b !== c && a !== c) tris.push(a, b, c);
        }
      } else continue;

      const shapeWorld = world(boneIndex);
      const normalMatrices = new Map();
      const normalOf = (t) => {
        if (!normalMatrices.has(t)) normalMatrices.set(t, mat4.normal(t));
        return normalMatrices.get(t);
      };
      const remap = new Map();
      const positions = [];
      const normals = [];
      const uvs = [];
      const hasNormal = !!attribs._n0?.read;
      const hasUv = !!attribs._u0?.read;
      const hasUv2 = !!attribs._u1?.read;
      const uvs2 = [];
      const joints = [];
      const weights = [];
      const indices = new Uint32Array(tris.length);
      tris.forEach((v, i) => {
        let k = remap.get(v);
        if (k === undefined) {
          k = remap.size;
          remap.set(v, k);
          let transform = skinCount === 0 ? shapeWorld : null;
          let influences = [[boneIndex, 1]];
          if (skinCount === 1) {
            const bone = matrixBone(get("_i0", v)?.[0] ?? 0);
            transform = world(bone);
            influences = [[bone, 1]];
          } else if (skinCount > 1) {
            const ids = [...(get("_i0", v) || []), ...(get("_i1", v) || [])];
            const ws = [...(get("_w0", v) || []), ...(get("_w1", v) || [])];
            influences = ids.slice(0, skinCount).map((id, n) => [matrixBone(id), ws[n] ?? 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
            if (!influences.length) influences = [[boneIndex, 1]];
          }
          const total = influences.reduce((n, x) => n + x[1], 0) || 1;
          influences.forEach(([bone, w], n) => {
            joints.push(bone);
            weights.push(w / total);
          });
          for (let n = influences.length; n < 4; n++) {
            joints.push(0);
            weights.push(0);
          }
          const p = get("_p0", v);
          positions.push(...(transform ? mat4.point(transform, p[0], p[1], p[2] || 0) : [p[0], p[1], p[2] || 0]));
          if (hasNormal) {
            const n = get("_n0", v);
            const w = transform ? mat4.point(normalOf(transform), n[0], n[1], n[2]) : n;
            const len = Math.hypot(w[0], w[1], w[2]) || 1;
            normals.push(w[0] / len, w[1] / len, w[2] / len);
          }
          if (hasUv) {
            const uv = get("_u0", v);
            uvs.push(uv[0], 1 - uv[1]);
          }
          if (hasUv2) {
            const uv = get("_u1", v);
            uvs2.push(uv[0], 1 - uv[1]);
          }
        }
        indices[i] = k;
      });
      meshes.push({
        name: str(u64(shape + 0x08)),
        positions: new Float32Array(positions),
        normals: hasNormal ? new Float32Array(normals) : null,
        uvs: hasUv ? new Float32Array(uvs) : null,
        uvs2: hasUv2 ? new Float32Array(uvs2) : null,
        skin: m === 0 && bones.length ? { joints: new Uint16Array(joints), weights: new Float32Array(weights) } : null,
        groups: [{ material: materials[materialIndex] || null, indices }]
      });
    }
    if (m === 0 && bones.length) skeletonOut = { bones, inverse: bones.map((_, i) => mat4.invert(world(i))) };
  }
  return { label, meshes, skeleton: skeletonOut, animations };
};

export { readBfres, bfresPose, bfresTrs, evalBfresCurve, quatToEulerXYZ, bfresAttribReader, bfresLocal, BFRES_COMPONENTS, BFRES_ROLES, BFRES_ANIM_TARGETS };
