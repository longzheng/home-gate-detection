import mqtt from 'mqtt';
import 'dotenv/config';
import type { ClassifyLabels } from './helpers/classifier.js';
import { classifyImage } from './helpers/classifier.js';
import { getCameraImage } from './helpers/camera.js';
import { getBooleanEnv, getRequiredEnv } from './helpers/env.js';
import { saveCroppedImage } from './helpers/image-storage.js';
import { logWithTimestamp } from './helpers/logger.js';

const mqttHost = getRequiredEnv('MQTT_HOST');
const saveOpenImages = getBooleanEnv('SAVE_OPEN_IMAGES');
const saveClosedImages = getBooleanEnv('SAVE_CLOSED_IMAGES');
const uniqueId = 'home_gate_detection_driveway_gate';
const mqttTopic = `homeassistant/binary_sensor/${uniqueId}/state`;
const mqttClient = mqtt.connect(mqttHost);

mqttClient.on('connect', () => {
    logWithTimestamp('Connected to MQTT broker');
    // Publish MQTT discovery configuration for Home Assistant auto-discovery using auto-generated topic
    const discoveryTopic = `homeassistant/binary_sensor/${uniqueId}/config`;
    const configPayload = JSON.stringify({
        name: 'Driveway Gate',
        state_topic: mqttTopic,
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

// state for debounced classification updates
let lastClassificationReceived: ClassifyLabels | null = null;
let consecutiveCount = 0;
let lastPublishedClassification: ClassifyLabels | null = null;

for (;;) {
    try {
        const classification = await classifyGate();
        // count consecutive occurrences of the same classification
        if (classification === lastClassificationReceived) {
            consecutiveCount++;
        } else {
            lastClassificationReceived = classification;
            consecutiveCount = 1;
        }
        // only update when two consecutive readings differ from last published state
        if (
            classification !== lastPublishedClassification &&
            consecutiveCount >= 2
        ) {
            updateMqttState(classification);
            lastPublishedClassification = classification;
        }
    } catch (error) {
        if (error instanceof Error) {
            logWithTimestamp(`exception: ${error.message}
${error.stack ? error.stack.toString() : ''}`);
            continue;
        }

        throw error;
    }
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
    const confidenceThreshold = 0.9;
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

function updateMqttState(classification: ClassifyLabels) {
    const state = classification === 'open' ? 'on' : 'off';
    const payload = state;
    mqttClient.publish(mqttTopic, payload, (err) => {
        if (err) {
            logWithTimestamp(`MQTT publish error: ${err.message}`);
        } else {
            logWithTimestamp(
                `Published state '${state}' to MQTT topic '${mqttTopic}'`,
            );
        }
    });
}
