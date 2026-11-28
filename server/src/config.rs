use std::{env, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use percent_encoding::percent_decode_str;
use reqwest::Url;
use rumqttc::MqttOptions;

#[derive(Clone, Copy)]
pub struct Crop {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

pub struct Config {
    pub camera_url: Url,
    pub camera_username: String,
    pub camera_password: String,
    pub crop: Crop,
    pub mqtt: Option<MqttOptions>,
    pub save_open: bool,
    pub save_closed: bool,
    pub stale_timeout: Duration,
    pub max_gap: Duration,
}

impl Config {
    pub fn load() -> Result<Self> {
        match dotenvy::from_path(".env") {
            Ok(_) => (),
            Err(error) if error.not_found() => (),
            Err(error) => return Err(error).context("load .env"),
        }

        let camera_url = Url::parse(&required("CAMERA_URL")?).context("invalid CAMERA_URL")?;
        ensure!(
            matches!(camera_url.scheme(), "http" | "https") && camera_url.host().is_some(),
            "CAMERA_URL must be an HTTP or HTTPS URL"
        );
        let crop = Crop {
            left: coordinate("CAMERA_CROP_LEFT")?,
            top: coordinate("CAMERA_CROP_TOP")?,
            width: coordinate("CAMERA_CROP_WIDTH")?,
            height: coordinate("CAMERA_CROP_HEIGHT")?,
        };
        ensure!(
            crop.width > 0 && crop.height > 0,
            "crop dimensions must be positive"
        );

        Ok(Self {
            camera_url,
            camera_username: required("CAMERA_USERNAME")?,
            camera_password: required("CAMERA_PASSWORD")?,
            crop,
            mqtt: mqtt_options()?,
            save_open: flag("SAVE_OPEN_IMAGES")?,
            save_closed: flag("SAVE_CLOSED_IMAGES")?,
            stale_timeout: timeout("STALE_STATE_TIMEOUT_MS", 30_000)?,
            max_gap: timeout("DEBOUNCE_MAX_GAP_MS", 5_000)?,
        })
    }
}

fn optional(key: &str) -> Result<Option<String>> {
    match env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {key}")),
    }
}

fn required(key: &str) -> Result<String> {
    optional(key)?
        .filter(|value| !value.is_empty())
        .with_context(|| format!("missing environment variable {key}"))
}

fn coordinate(key: &str) -> Result<u32> {
    required(key)?
        .trim()
        .parse()
        .with_context(|| format!("{key} must be a nonnegative integer"))
}

fn flag(key: &str) -> Result<bool> {
    let Some(value) = optional(key)? else {
        return Ok(false);
    };
    value
        .trim()
        .to_ascii_lowercase()
        .parse()
        .with_context(|| format!("{key} must be true or false"))
}

fn timeout(key: &str, default_ms: u64) -> Result<Duration> {
    let Some(value) = optional(key)? else {
        return Ok(Duration::from_millis(default_ms));
    };
    let invalid = || format!("{key} must be a positive finite duration in milliseconds");
    let millis: f64 = value.trim().parse().with_context(invalid)?;
    let duration = Duration::try_from_secs_f64(millis / 1_000.0).with_context(invalid)?;
    ensure!(!duration.is_zero(), invalid());
    Ok(duration)
}

fn mqtt_options() -> Result<Option<MqttOptions>> {
    let Some(host) = optional("MQTT_HOST")?.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let url = Url::parse(&format!("mqtt://{host}")).context("invalid MQTT_HOST")?;
    let Some(host) = url.host() else {
        bail!("MQTT_HOST must specify a host and optional port");
    };
    let host = match host {
        url::Host::Ipv6(address) => address.to_string(),
        host => host.to_string(),
    };
    let mut options = MqttOptions::new(
        format!("gate-{:016x}", rand::random::<u64>()),
        host,
        url.port().unwrap_or(1883),
    );
    if !url.username().is_empty() {
        options.set_credentials(
            percent_decode_str(url.username())
                .decode_utf8()?
                .into_owned(),
            percent_decode_str(url.password().unwrap_or_default())
                .decode_utf8()?
                .into_owned(),
        );
    }
    Ok(Some(options))
}
