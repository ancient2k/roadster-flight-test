// Web Worker running the ground-cloud simulation and light bake off the main thread.
// The bake buffer ping-pongs between the threads (transferred, never copied).
import { CloudSim, runStep, type CloudStepRequest } from './cloudSim';

const sim = new CloudSim();

self.onmessage = (e: MessageEvent<CloudStepRequest>) => {
  const res = runStep(sim, e.data);
  (self as unknown as Worker).postMessage(res, [res.buf]);
};
