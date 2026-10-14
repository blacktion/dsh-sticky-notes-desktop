/**
 * Drive OBS Studio over its WebSocket protocol (obs-websocket v5, OBS 28+).
 *
 * Implemented over a raw TCP socket rather than Node's `http` upgrade event: with the `http` path
 * OBS's post-upgrade frames were never delivered to the caller, so the protocol Hello never arrived
 * and every connection looked like a server that accepted the handshake and then went silent. Writing
 * the upgrade request by hand and parsing the response off the socket works.
 *
 * Usage:
 *   node tools/obs.mjs <password> <command> [args...]
 *
 * Commands:
 *   info                 server version, record state, output path
 *   scenes               list scenes
 *   audio                list audio inputs
 *   start                start recording
 *   stop                 stop recording (returns the output path)
 *   startfor <seconds>   start recording with an OBS-side stop timer
 *   snapshot [path]      save a still of the current program scene
 *
 * @module dsh-sticky-notes-desktop/tools/obs
 */
import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const [, , password = '', command = 'info', ...args] = process.argv;

/** obs-websocket v5 auth: base64(sha256(base64(sha256(password + salt)) + challenge)). */
function authString(pass, salt, challenge) {
  const secret = createHash('sha256').update(pass + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

/**
 * Open one authenticated connection, run `run(call)`, close.
 *
 * @param {string} pass
 * @param {(call: (type: string, data?: object) => Promise<any>) => Promise<any>} run
 * @param {number} [timeoutMs]
 */
function withObs(pass, run, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = connect(4455, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let nextId = 0;
    let settled = false;
    const pending = new Map();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      fn(value);
    };

    const guard = setTimeout(() => finish(reject, new Error(`OBS did not answer within ${timeoutMs}ms`)), timeoutMs);

    /** Client frames must be masked. Payloads here are small, but the 16-bit length case is handled. */
    const sendFrame = (payload) => {
      const data = Buffer.from(JSON.stringify(payload), 'utf8');
      const mask = randomBytes(4);
      const len = data.length;
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
      else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    };

    const call = (requestType, requestData) =>
      new Promise((res, rej) => {
        nextId += 1;
        const id = String(nextId);
        pending.set(id, { res, rej });
        sendFrame({ op: 6, d: { requestType, requestId: id, requestData: requestData ?? {} } });
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error(`OBS request timed out: ${requestType}`));
        }, 8000);
      });

    /** Read one WebSocket frame from the buffer, or null when more bytes are needed. */
    const readFrame = () => {
      if (buffer.length < 2) return null;
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + len) return null;
      const payload = buffer.subarray(offset, offset + len);
      buffer = buffer.subarray(offset + len);
      return { opcode, payload };
    };

    const handleMessage = (msg) => {
      if (msg.op === 0) {
        const identify = { op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } };
        if (msg.d.authentication) {
          identify.d.authentication = authString(pass, msg.d.authentication.salt, msg.d.authentication.challenge);
        }
        sendFrame(identify);
        return;
      }
      if (msg.op === 2) {
        run(call).then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
        return;
      }
      if (msg.op === 7 && pending.has(String(msg.d?.requestId))) {
        const entry = pending.get(String(msg.d.requestId));
        pending.delete(String(msg.d.requestId));
        if (msg.d.requestStatus?.result) entry.res(msg.d);
        else entry.rej(new Error(`${msg.d.requestType}: ${msg.d.requestStatus?.comment ?? 'failed'}`));
      }
    };

    socket.on('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\n' +
          'Host: 127.0.0.1:4455\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('utf8');
        if (!/^HTTP\/1\.1 101/.test(head)) return finish(reject, new Error(`OBS refused the upgrade: ${head.split('\r\n')[0]}`));
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      for (;;) {
        const frame = readFrame();
        if (frame === null) return;
        if (frame.opcode === 0x8) return finish(reject, new Error('OBS closed the connection'));
        if (frame.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }
        handleMessage(msg);
      }
    });

    socket.on('error', (error) => finish(reject, error));
  });
}

const output = await withObs(password, async (call) => {
  const version = await call('GetVersion');
  const base = { obsVersion: version.responseData.obsVersion, webSocketVersion: version.responseData.obsWebSocketVersion };

  switch (command) {
    case 'info': {
      const state = await call('GetRecordStatus');
      return { ...base, outputActive: state.responseData.outputActive, outputPath: state.responseData.outputPath ?? null };
    }
    case 'scenes': {
      const scenes = await call('GetSceneList');
      return {
        ...base,
        currentProgramScene: scenes.responseData.currentProgramSceneName,
        scenes: scenes.responseData.scenes.map((s) => s.sceneName),
      };
    }
    case 'audio': {
      const inputs = await call('GetInputList');
      return { ...base, inputs: inputs.responseData.inputs.map((i) => `${i.inputName} [${i.inputKind}]`) };
    }
    case 'start': {
      await call('StartRecord');
      return { ...base, started: true };
    }
    case 'stop': {
      const res = await call('StopRecord');
      return { ...base, stopped: true, outputPath: res.responseData?.outputPath ?? null };
    }
    case 'startfor': {
      const seconds = Number(args[0] ?? 60);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('startfor needs a positive number of seconds');
      await call('StartRecord', { recordTimer: seconds });
      return { ...base, startedForSeconds: seconds };
    }
    case 'scene-items': {
      const scene = await call('GetCurrentProgramScene');
      const name = scene.responseData.currentProgramSceneName;
      const list = await call('GetSceneItemList', { sceneName: name });
      const items = [];
      for (const item of list.responseData.sceneItems) {
        const id = await call('GetSceneItemId', { sceneName: name, sourceName: item.sourceName });
        const st = await call('GetInputSettings', { inputName: item.sourceName });
        items.push({
          sceneItemId: id.responseData.sceneItemId,
          sourceName: item.sourceName,
          enabled: item.sceneItemEnabled,
          kind: st.responseData.inputKind ?? null,
          settings: st.responseData.inputSettings ?? {},
        });
      }
      return { ...base, scene: name, items };
    }
    case 'disable-item': {
      // args: <sceneItemId>
      const scene = await call('GetCurrentProgramScene');
      const sceneName = scene.responseData.currentProgramSceneName;
      const sceneItemId = Number(args[0]);
      if (!Number.isInteger(sceneItemId)) throw new Error('disable-item needs a numeric sceneItemId');
      await call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: false });
      return { ...base, disabled: sceneItemId, sceneName };
    }
    case 'enable-item': {
      const scene = await call('GetCurrentProgramScene');
      const sceneName = scene.responseData.currentProgramSceneName;
      const sceneItemId = Number(args[0]);
      if (!Number.isInteger(sceneItemId)) throw new Error('enable-item needs a numeric sceneItemId');
      await call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });
      return { ...base, enabled: sceneItemId, sceneName };
    }
    case 'snapshot': {
      const scene = await call('GetCurrentProgramScene');
      const target = args[0] ?? 'obs-snapshot.png';
      const res = await call('SaveSourceScreenshot', {
        sourceName: scene.responseData.currentProgramSceneName,
        imageFormat: 'png',
        imageFilePath: target,
      });
      return { ...base, saved: target, imageFile: res.responseData?.imageFile ?? null };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
});

console.log(JSON.stringify(output, null, 2));
