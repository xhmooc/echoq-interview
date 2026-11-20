import fs from 'node:fs';
import path from 'node:path';
import { ocr } from 'ppu-indra-ocr';

const dir = path.join(process.env.TEMP, 'echoq-dev-test', 'models', 'indra', 'v1.1');
const models = {
  det: path.join(dir, 'det.onnx'),
  rec: path.join(dir, 'rec.onnx'),
  recCjk: path.join(dir, 'rec_cjk.onnx'),
  recRtl: path.join(dir, 'rec_rtl.onnx'),
  recWorld: path.join(dir, 'rec_world.onnx'),
  script: path.join(dir, 'script.onnx'),
  orient: path.join(dir, 'orient.onnx'),
  order: path.join(dir, 'order.onnx'),
  meta: path.join(dir, 'meta.json'),
};
const f = process.argv[2];
const t0 = Date.now();
const page = await ocr(fs.readFileSync(f), { model: 'v1.1', lm: false, models });
console.log(`${Date.now() - t0}ms`);
console.log('TEXT>>');
console.log(page.text);
console.log('<<TEXT');
