package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.util.List;
import java.util.Objects;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
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

	/** 요청·응답 실패와 쓸 수 있는 TURN 서버가 없는 응답은 모두 {@link RestClientException}으로 알린다. */
	public TurnCredentialMaterial issue(long ttlSeconds) {
		CredentialResponse response = restClient.post()
				.uri(
						"/v1/turn/keys/{keyId}/credentials/generate-ice-servers",
						properties.cloudflareKeyId())
				.headers(headers -> headers.setBearerAuth(properties.cloudflareApiToken()))
				.contentType(MediaType.APPLICATION_JSON)
				.body(new CredentialRequest(ttlSeconds))
				.retrieve()
				.body(CredentialResponse.class);
		if (response == null || response.iceServers() == null) {
			throw new RestClientException("Cloudflare TURN credential response is empty");
		}

		return response.iceServers().stream()
				.filter(Objects::nonNull)
				.filter(server -> StringUtils.hasText(server.username()))
				.filter(server -> StringUtils.hasText(server.credential()))
				.map(server -> new TurnCredentialMaterial(
						turnUrls(server.urls()),
						server.username(),
						server.credential()))
				.filter(credentials -> !credentials.urls().isEmpty())
				.findFirst()
				.orElseThrow(() -> new RestClientException(
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
}
