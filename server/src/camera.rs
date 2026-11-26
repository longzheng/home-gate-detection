use std::time::Duration;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use digest_auth::{AuthContext, WwwAuthenticateHeader};
use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    header::{AUTHORIZATION, WWW_AUTHENTICATE},
};

use crate::config::Config;

pub struct Camera<'a> {
    client: Client,
    config: &'a Config,
    challenge: Option<(Url, WwwAuthenticateHeader)>,
}

impl<'a> Camera<'a> {
    pub fn new(config: &'a Config) -> Result<Self> {
        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(10)).build()?,
            config,
            challenge: None,
        })
    }

    pub fn snapshot(&mut self) -> Result<Bytes> {
        let mut response = self.request().context("request camera snapshot")?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let challenge = response
                .headers()
                .get_all(WWW_AUTHENTICATE)
                .iter()
                .filter_map(|header| header.to_str().ok())
                .find(|header| {
                    header
                        .split_once(' ')
                        .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("digest"))
                });
            let Some(challenge) = challenge else {
                self.challenge = None;
                bail!("camera did not offer HTTP Digest authentication");
            };
            let challenge =
                digest_auth::parse(challenge).context("parse camera Digest challenge")?;
            self.challenge = Some((response.url().clone(), challenge));
            let _ = response.bytes();
            response = self
                .request()
                .context("retry camera snapshot with Digest auth")?;
        }
        if response.status() == StatusCode::UNAUTHORIZED {
            self.challenge = None;
        }
        Ok(response.error_for_status()?.bytes()?)
    }

    fn request(&mut self) -> Result<Response> {
        let Some((url, challenge)) = &mut self.challenge else {
            return Ok(self.client.get(self.config.camera_url.clone()).send()?);
        };
        // The Digest URI includes the query string, and the challenge tracks nonce reuse.
        let uri = &url[url::Position::BeforePath..url::Position::AfterQuery];
        let context = AuthContext::new(
            self.config.camera_username.as_str(),
            self.config.camera_password.as_str(),
            uri,
        );
        let authorization = challenge.respond(&context)?.to_header_string();
        Ok(self
            .client
            .get(url.clone())
            .header(AUTHORIZATION, authorization)
            .send()?)
    }
}
