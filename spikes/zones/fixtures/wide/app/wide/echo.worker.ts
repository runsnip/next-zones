/* A Web Worker running a module the shell has too (React): its chunk is written again under Zones (workers.mjs). */
import { version } from "react";

self.onmessage = (event: MessageEvent<string>) => self.postMessage(`echo ${event.data}, react ${typeof version}`);
