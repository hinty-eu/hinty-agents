// @ts-check
// Registry of the speech models (E3). Files come from Hugging Face / GitHub releases of sherpa-onnx; each file has a
// pinned size and sha256, checked after the download (a wrong sum = the file is thrown away).
import path from 'node:path'
import { homeDir } from '../store.js'

const HF = 'https://huggingface.co/csukuangfj'
export const SHERPA_VERSION = '2.0.2'

/**
 * @typedef {{ name: string, url: string, size: number, sha256: string }} ModelFile
 * @typedef {{ id: string, label: string, kind: 'transducer' | 'whisper' | 'vad', langs: string, files: ModelFile[] }} Model
 */

/** @type {Record<string, Model>} */
export const MODELS = {
  'parakeet-v3': {
    id: 'parakeet-v3',
    label: 'NVIDIA Parakeet TDT 0.6b v3 (int8), 25 European languages incl. Polish, CC BY 4.0',
    kind: 'transducer',
    langs: 'multi',
    files: [
      { name: 'encoder.int8.onnx', url: `${HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx`, size: 652282294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479' },
      { name: 'decoder.int8.onnx', url: `${HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx`, size: 11845274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5' },
      { name: 'joiner.int8.onnx', url: `${HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx`, size: 6355277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98' },
      { name: 'tokens.txt', url: `${HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt`, size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    ],
  },
  'whisper-small': {
    id: 'whisper-small',
    label: 'OpenAI Whisper small (int8), multilingual, MIT (fallback)',
    kind: 'whisper',
    langs: 'multi',
    files: [
      { name: 'small-encoder.int8.onnx', url: `${HF}/sherpa-onnx-whisper-small/resolve/main/small-encoder.int8.onnx`, size: 112442483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { name: 'small-decoder.int8.onnx', url: `${HF}/sherpa-onnx-whisper-small/resolve/main/small-decoder.int8.onnx`, size: 262226114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      { name: 'small-tokens.txt', url: `${HF}/sherpa-onnx-whisper-small/resolve/main/small-tokens.txt`, size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  'whisper-turbo': {
    id: 'whisper-turbo',
    label: 'OpenAI Whisper large-v3-turbo (int8), multilingual, MIT (fallback, bigger)',
    kind: 'whisper',
    langs: 'multi',
    files: [
      { name: 'turbo-encoder.int8.onnx', url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-encoder.int8.onnx`, size: 674716297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
      { name: 'turbo-decoder.int8.onnx', url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-decoder.int8.onnx`, size: 361080764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
      { name: 'turbo-tokens.txt', url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-tokens.txt`, size: 816730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  'silero-vad': {
    id: 'silero-vad',
    label: 'Silero VAD (voice activity detection), MIT',
    kind: 'vad',
    langs: '-',
    files: [
      { name: 'silero_vad.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
    ],
  },
}

export const DEFAULT_MODEL = 'parakeet-v3'
export const VAD_MODEL = 'silero-vad'

export const modelsDir = () => path.join(homeDir(), 'models')
export const voiceDir = () => path.join(homeDir(), 'voice')
/** @param {string} id */
export const modelDir = (id) => path.join(modelsDir(), id)
/** @param {string} id */
export const modelPath = (id, /** @type {string} */ name) => path.join(modelDir(id), name)
export const voiceConfigFile = () => path.join(homeDir(), 'voice.json')
