package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.util.List;
import java.util.Objects;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class CloudflareTurnClient {

	private static final String API_BASE_URL = "https://rtc.live.cloudflare.com";

	private final RestClient restClient;
	private final TurnProperties properties;

	public CloudflareTurnClient(
			RestClient.Builder restClientBuilder,
			TurnProperties properties) {
		this.restClient = restClientBuilder.baseUrl(API_BASE_URL).build();
		this.properties = properties;
	}

	public TurnCredentialMaterial issue(long ttlSeconds) {
		try {
			CredentialResponse response = restClient.post()
					.uri(
							"/v1/turn/keys/{keyId}/credentials/generate-ice-servers",
							properties.cloudflareKeyId())
					.headers(headers -> headers.setBearerAuth(properties.cloudflareApiToken()))
					.contentType(MediaType.APPLICATION_JSON)
					.body(new CredentialRequest(ttlSeconds))
					.retrieve()
					.body(CredentialResponse.class);
			return credentialsFrom(response);
		}
		catch (RestClientException exception) {
			throw new ProviderUnavailableException(
					"Cloudflare TURN credential request failed",
					exception);
		}
	}

	private static TurnCredentialMaterial credentialsFrom(CredentialResponse response) {
		if (response == null || response.iceServers() == null) {
			throw new ProviderUnavailableException(
					"Cloudflare TURN credential response is empty");
		}

		return response.iceServers().stream()
				.filter(Objects::nonNull)
				.filter(server -> server.username() != null && !server.username().isBlank())
				.filter(server -> server.credential() != null && !server.credential().isBlank())
				.map(server -> new TurnCredentialMaterial(
						turnUrls(server.urls()),
						server.username(),
						server.credential()))
				.filter(credentials -> !credentials.urls().isEmpty())
				.findFirst()
				.orElseThrow(() -> new ProviderUnavailableException(
						"Cloudflare TURN credential response has no usable TURN server"));
	}

	private static List<String> turnUrls(List<String> urls) {
		if (urls == null) {
			return List.of();
		}
		return urls.stream()
				.filter(url -> url != null
						&& (url.startsWith("turn:") || url.startsWith("turns:")))
				.filter(url -> !url.contains(":53?"))
				.toList();
	}

	private record CredentialRequest(long ttl) {
	}

	private record CredentialResponse(List<IceServer> iceServers) {
	}

	private record IceServer(
			List<String> urls,
			String username,
			String credential) {
	}

	public static final class ProviderUnavailableException extends RuntimeException {

		ProviderUnavailableException(String message) {
			super(message);
		}

		ProviderUnavailableException(String message, Throwable cause) {
			super(message, cause);
		}
	}
}
