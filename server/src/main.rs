mod camera;
mod classifier;
mod config;
mod gate_state;
mod mqtt;

use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use camera::Camera;
use classifier::Classifier;
use config::Config;
use gate_state::{GateState, Reading};
use tokio::sync::watch;
use tracing::{debug, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let config = Config::load()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let mqtt = config.mqtt.clone();
    let stale_timeout = config.stale_timeout;
    let (sender, receiver) = watch::channel(None);
    let worker = tokio::task::spawn_blocking(move || detect(config, sender));

    if let Some(options) = mqtt {
        tokio::select! {
            result = worker => result.context("detection worker stopped")?,
            () = mqtt::run(options, receiver, stale_timeout) => Ok(()),
        }
    } else {
        worker.await.context("detection worker stopped")?
    }
}

fn detect(config: Config, sender: watch::Sender<Option<Reading>>) -> Result<()> {
    let mut camera = Camera::new(&config)?;
    let mut classifier = Classifier::load(Path::new("best.onnx"))?;
    let mut gate = GateState::new(config.stale_timeout, config.max_gap);

    loop {
        let captured_at = Instant::now();
        let result = camera.snapshot().and_then(|snapshot| {
            debug!(
                elapsed_ms = captured_at.elapsed().as_secs_f64() * 1000.0,
                "captured snapshot"
            );
            classifier.classify(snapshot.as_ref(), &config)
        });
        match result {
            Ok(label) => {
                let reading = Reading { label, captured_at };
                if let Some(confirmed) = gate.read(reading, Instant::now()) {
                    sender.send_replace(Some(confirmed));
                }
            }
            Err(error) => {
                gate.fail();
                warn!(error = %format_args!("{error:#}"), "snapshot classification failed");
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
}
