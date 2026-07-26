package com.personal.round.config;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "round.turn")
public class TurnProperties {

	private List<String> urls = new ArrayList<>();
	private String sharedSecret = "";
	private long credentialTtlSeconds = 3_600;
	private long rateLimitWindowSeconds = 60;
	private int rateLimitMaxRequests = 12;
	private int rateLimitMaxClients = 10_000;

	public List<String> getUrls() {
		return urls.stream().filter(url -> url != null && !url.isBlank()).toList();
	}

	public void setUrls(List<String> urls) {
		this.urls = urls == null ? new ArrayList<>() : new ArrayList<>(urls);
	}

	public String getSharedSecret() {
		return sharedSecret;
	}

	public void setSharedSecret(String sharedSecret) {
		this.sharedSecret = sharedSecret == null ? "" : sharedSecret;
	}

	public long getCredentialTtlSeconds() {
		return credentialTtlSeconds;
	}

	public void setCredentialTtlSeconds(long credentialTtlSeconds) {
		this.credentialTtlSeconds = credentialTtlSeconds;
	}

	public long getRateLimitWindowSeconds() {
		return rateLimitWindowSeconds;
	}

	public void setRateLimitWindowSeconds(long rateLimitWindowSeconds) {
		this.rateLimitWindowSeconds = rateLimitWindowSeconds;
	}

	public int getRateLimitMaxRequests() {
		return rateLimitMaxRequests;
	}

	public void setRateLimitMaxRequests(int rateLimitMaxRequests) {
		this.rateLimitMaxRequests = rateLimitMaxRequests;
	}

	public int getRateLimitMaxClients() {
		return rateLimitMaxClients;
	}

	public void setRateLimitMaxClients(int rateLimitMaxClients) {
		this.rateLimitMaxClients = rateLimitMaxClients;
	}

	public boolean isEnabled() {
		return !getUrls().isEmpty() && !sharedSecret.isBlank();
	}

	public void validate() {
		boolean hasUrls = !getUrls().isEmpty();
		boolean hasSecret = !sharedSecret.isBlank();
		if (hasUrls != hasSecret) {
			throw new IllegalArgumentException(
					"round.turn.urls and round.turn.shared-secret must be configured together");
		}
		for (String url : getUrls()) {
			if (!(url.startsWith("turn:") || url.startsWith("turns:"))
					|| url.chars().anyMatch(Character::isWhitespace)
					|| url.contains("@")) {
				throw new IllegalArgumentException(
						"round.turn.urls must contain only credential-free turn: or turns: URLs");
			}
		}
		if (credentialTtlSeconds < 300 || credentialTtlSeconds > 7 * 24 * 60 * 60) {
			throw new IllegalArgumentException(
					"round.turn.credential-ttl-seconds must be between 300 and 604800");
		}
		if (rateLimitWindowSeconds < 1 || rateLimitWindowSeconds > 3_600) {
			throw new IllegalArgumentException(
					"round.turn.rate-limit-window-seconds must be between 1 and 3600");
		}
		if (rateLimitMaxRequests < 1 || rateLimitMaxRequests > 10_000) {
			throw new IllegalArgumentException(
					"round.turn.rate-limit-max-requests must be between 1 and 10000");
		}
		if (rateLimitMaxClients < 1 || rateLimitMaxClients > 1_000_000) {
			throw new IllegalArgumentException(
					"round.turn.rate-limit-max-clients must be between 1 and 1000000");
		}
	}
}
