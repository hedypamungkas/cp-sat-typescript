/**
 * Worker entry point. This file is what the orchestrator spawns as a worker
 * (browser Web Worker / Node worker_thread). It only boots the message loop;
 * all logic lives in worker-entry.ts (importable in-process for tests).
 */
import { startWorker } from './worker-entry';

void startWorker();
