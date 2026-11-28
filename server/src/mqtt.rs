use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rumqttc::{AsyncClient, Event, EventLoop, LastWill, MqttOptions, Outgoing, Packet, QoS};
use serde_json::json;
use tokio::{sync::watch, time};
use tracing::{info, warn};

use crate::gate_state::{Label, Reading};

const UNIQUE_ID: &str = "home_gate_detection_driveway_gate";
const TOPIC_PREFIX: &str = "homeassistant/binary_sensor/home_gate_detection_driveway_gate";

pub async fn run(
    mut options: MqttOptions,
    mut readings: watch::Receiver<Option<Reading>>,
    stale_timeout: Duration,
) {
    let availability = format!("{TOPIC_PREFIX}/availability");
    options.set_last_will(LastWill::new(
        &availability,
        "offline",
        QoS::AtLeastOnce,
        true,
    ));
    let state = format!("{TOPIC_PREFIX}/state");
    let discovery = format!("{TOPIC_PREFIX}/config");
    let configuration = json!({
        "name": "Driveway Gate",
        "state_topic": state,
        "availability_topic": availability,
        "payload_available": "online",
        "payload_not_available": "offline",
        "payload_on": "on",
        "payload_off": "off",
        "device_class": "garage_door",
        "unique_id": UNIQUE_ID,
    })
    .to_string();

    loop {
        // Discard in-flight publications on disconnect. A new connection publishes fresh evidence.
        let (client, mut event_loop) = AsyncClient::new(options.clone(), 1);
        let result: Result<()> = async {
            event_loop.poll().await.context("connect to MQTT broker")?;
            info!("connected to MQTT broker");
            publish(&client, &mut event_loop, &discovery, &configuration).await?;

            let mut last_published = None;
            let mut watchdog = time::interval(Duration::from_millis(250));
            watchdog.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
            loop {
                let snapshot = current(&readings, stale_timeout);
                if last_published != Some(snapshot) {
                    if let Some(label) = snapshot {
                        let payload = if label == Label::Open { "on" } else { "off" };
                        publish(&client, &mut event_loop, &state, payload).await?;
                        // The frame can expire or be replaced while waiting for PUBACK.
                        if current(&readings, stale_timeout) != snapshot {
                            last_published = None;
                            continue;
                        }
                    }
                    let payload = if snapshot.is_some() {
                        "online"
                    } else {
                        "offline"
                    };
                    publish(&client, &mut event_loop, &availability, payload).await?;
                    last_published = Some(snapshot);
                    info!(?snapshot, "published MQTT gate state");
                }
                tokio::select! {
                    event = event_loop.poll() => { event?; }
                    changed = readings.changed() => { changed?; }
                    _ = watchdog.tick() => {}
                }
            }
        }
        .await;
        if let Err(error) = result {
            warn!(%error, "MQTT connection lost, retrying");
        }
        time::sleep(Duration::from_secs(1)).await;
    }
}

fn current(readings: &watch::Receiver<Option<Reading>>, stale_timeout: Duration) -> Option<Label> {
    readings
        .borrow()
        .filter(|reading| reading.fresh_at(Instant::now(), stale_timeout))
        .map(|reading| reading.label)
}

async fn publish(
    client: &AsyncClient,
    event_loop: &mut EventLoop,
    topic: &str,
    payload: &str,
) -> Result<()> {
    client.try_publish(topic, QoS::AtLeastOnce, true, payload)?;
    time::timeout(Duration::from_secs(5), async {
        let mut packet_id = None;
        loop {
            match event_loop.poll().await? {
                Event::Outgoing(Outgoing::Publish(id)) => packet_id = Some(id),
                Event::Incoming(Packet::PubAck(ack)) if Some(ack.pkid) == packet_id => {
                    return Ok(());
                }
                _ => (),
            }
        }
    })
    .await
    .with_context(|| format!("timed out publishing MQTT topic {topic}"))?
}
