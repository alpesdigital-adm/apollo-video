import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The private runtime the W67 pixel oracle runs in on the supervised Windows host: the Python 3.14 interpreter and the hash-pinned package
 * root (OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1) that W61/W62 used, and the two OMZ model directories. Nothing here is committed
 * media; the pins are the digests the bridge and the TypeScript twin re-check on every batch.
 */
export const BASE = 'C:/Users/leand/Documents/Apollo/w61-70-20261008'
export const PYTHON = 'C:/Python314/python.exe'
export const PYTHON_SHA256 = '467014615a5255aca450ae88100dd2caf887da87657f00e3c2171ec44a685aec'
// two package roots, as in W61/W62: OpenVINO lives beside the retail model, OpenCV and NumPy in the shared pydeps
export const PYTHON_MODULE_PATH = `${BASE}/openvino-retail0004-v7/pydeps;${BASE}/pydeps`
export const V9_MODEL_DIRECTORY = `${BASE}/w62-v8-acq-fb135f6a-2328-4722-a5d9-70e64b1a8a60/model-files`
export const RETAIL_MODEL_DIRECTORY = `${BASE}/openvino-retail0004-v7`
export const BRIDGE_PATH = resolve(import.meta.dirname, '../../../src/v2/infrastructure/perception/openvino_pixel_oracle_bridge.py')

export const sha256OfFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

export async function createOracle() {
  const { OpenvinoPixelOracle } = await import('../../../src/v2/infrastructure/perception/openvino-pixel-oracle.ts')
  return new OpenvinoPixelOracle({
    pythonExecutable: PYTHON, pythonExecutableSha256: sha256OfFile(PYTHON), pythonModulePath: PYTHON_MODULE_PATH,
    v9ModelDirectory: V9_MODEL_DIRECTORY, retailModelDirectory: RETAIL_MODEL_DIRECTORY,
    bridgePath: BRIDGE_PATH, bridgeSha256: sha256OfFile(BRIDGE_PATH), timeoutMs: 300_000,
  })
}
