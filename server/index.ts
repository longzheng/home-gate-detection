import mqtt from 'mqtt';
import 'dotenv/config';
import { classifyImage } from './helpers/classifier.js';
import { getCameraImage } from './helpers/camera.js';
import { GateState } from './helpers/gate-state.js';
import { getBooleanEnv, getPositiveNumberEnv } from './helpers/env.js';
import { saveCroppedImage } from './helpers/image-storage.js';
import { logWithTimestamp } from './helpers/logger.js';

const mqttHost = process.env['MQTT_HOST'];
const saveOpenImages = getBooleanEnv('SAVE_OPEN_IMAGES');
const saveClosedImages = getBooleanEnv('SAVE_CLOSED_IMAGES');
const uniqueId = 'home_gate_detection_driveway_gate';
const mqttTopic = `homeassistant/binary_sensor/${uniqueId}/state`;
const availabilityTopic = `homeassistant/binary_sensor/${uniqueId}/availability`;
const gateState = new GateState(
    getPositiveNumberEnv('STALE_STATE_TIMEOUT_MS', 30_000),
    getPositiveNumberEnv('DEBOUNCE_MAX_GAP_MS', 5_000),
);
const mqttClient = mqttHost
    ? mqtt.connect(`mqtt://${mqttHost}`, {
          will: {
              topic: availabilityTopic,
              payload: Buffer.from('offline'),
              qos: 1,
              retain: true,
          },
      })
    : null;
let publishedSnapshot: string | null = null;
let publishing = false;
let connectionGeneration = 0;

if (mqttClient) {
    mqttClient.on('connect', () => {
        logWithTimestamp('Connected to MQTT broker');
        connectionGeneration++;
        publishedSnapshot = null;
        // Publish MQTT discovery configuration for Home Assistant auto-discovery using auto-generated topic
        const discoveryTopic = `homeassistant/binary_sensor/${uniqueId}/config`;
        const configPayload = JSON.stringify({
            name: 'Driveway Gate',
            state_topic: mqttTopic,
            availability_topic: availabilityTopic,
            payload_available: 'online',
            payload_not_available: 'offline',
            payload_on: 'on',
            payload_off: 'off',
            device_class: 'garage_door',
            unique_id: uniqueId,
        });
        mqttClient.publish(
            discoveryTopic,
            configPayload,
            { retain: true },
            (err) => {
                if (err) {
                    logWithTimestamp(
                        `MQTT discovery publish error: ${err.message}`,
                    );
                } else {
                    logWithTimestamp(
                        `Published MQTT discovery config to ${discoveryTopic}`,
                    );
                }
            },
        );
    });

    mqttClient.on('error', (err) => {
        logWithTimestamp(`MQTT error: ${err.message}`);
    });
}

// This watchdog runs even while camera capture or inference is awaiting I/O.
setInterval(() => {
    void syncMqttState();
}, 250);

for (;;) {
    const capturedAt = performance.now();
    try {
        const classification = await classifyGate();
        gateState.read(classification, capturedAt, performance.now());
    } catch (error) {
        gateState.fail();
        if (!(error instanceof Error)) throw error;
        logWithTimestamp(`exception: ${error.message}\n${error.stack ?? ''}`);
        // Avoid hammering the camera when failures return immediately.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    void syncMqttState();
}

async function classifyGate() {
    // get image
    console.time('get_camera_image');
    const croppedImage = await getCameraImage();
    console.timeEnd('get_camera_image');

    // classify
    console.time('classify_image');
    const classify = await classifyImage({
        image: croppedImage,
    });
    console.timeEnd('classify_image');

    // filter out low confidence
    const confidenceThreshold = 0.95;
    const filtered = classify.filter(
        (classification) => classification.confidence > confidenceThreshold,
    );

    // sort by confidence result descending
    const result = filtered.sort((a, b) => b.confidence - a.confidence);

    if (result.length === 0 || !result[0]) {
        await saveCroppedImage(croppedImage, 'not-confident');
        throw new Error('no confident results');
    }

    const topResult = result[0];
    logWithTimestamp(`top result: ${JSON.stringify(topResult)}`);

    if (topResult.classification === 'open' && saveOpenImages) {
        await saveCroppedImage(croppedImage, 'open');
    }

    if (topResult.classification === 'closed' && saveClosedImages) {
        if (Math.random() < 0.01) {
            await saveCroppedImage(croppedImage, 'closed');
        }
    }

    return topResult.classification;
}

async function syncMqttState() {
    const classification = gateState.current(performance.now());
    if (!mqttClient?.connected || publishing) return;
    const snapshot = classification ?? 'offline';
    if (snapshot === publishedSnapshot) return;
    publishing = true;
    const generation = connectionGeneration;
    try {
        if (classification !== null) {
            await publish(mqttTopic, classification === 'open' ? 'on' : 'off');
        }
        // Never announce availability for evidence that expired during publication.
        if (
            gateState.current(performance.now()) !== classification ||
            generation !== connectionGeneration
        )
            return;
        await publish(
            availabilityTopic,
            classification === null ? 'offline' : 'online',
        );
        if (generation === connectionGeneration) publishedSnapshot = snapshot;
    } catch (error) {
        logWithTimestamp(`MQTT state publish error: ${String(error)}`);
    } finally {
        publishing = false;
    }
}

function publish(topic: string, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!mqttClient?.connected) {
            reject(new Error('MQTT disconnected'));
            return;
        }
        mqttClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}
