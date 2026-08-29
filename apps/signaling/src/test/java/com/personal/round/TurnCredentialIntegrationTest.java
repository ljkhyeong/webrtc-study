package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;

import com.personal.round.turn.CloudflareTurnClient;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.signaling.heartbeat-interval=60s",
			"round.turn.provider=cloudflare",
			"round.turn.cloudflare-key-id=integration-key",
			"round.turn.cloudflare-api-token=integration-token",
			"round.turn.credential-ttl=1h",
			"round.turn.rate-limit-window=60s",
			"round.turn.rate-limit-max-requests=2",
			"round.turn.rate-limit-global-max-requests=4"
		})
class TurnCredentialIntegrationTest {

	@LocalServerPort
	private int port;

	@MockitoBean
	private CloudflareTurnClient cloudflareTurnClient;

	private final AtomicLong credentialSequence = new AtomicLong();

	@BeforeEach
	void stubCloudflareCredentials() {
		when(cloudflareTurnClient.issue(anyLong())).thenAnswer(ignored -> {
			long sequence = credentialSequence.incrementAndGet();
			return new CloudflareTurnClient.Credentials(
					List.of(
							"turn:turn.cloudflare.com:3478?transport=udp",
							"turns:turn.cloudflare.com:443?transport=tcp"),
					"provider-user-" + sequence,
					"provider-credential-" + sequence);
		});
	}

	@Test
	void enforcesThePostOriginBoundaryAndAppliesClientAndGlobalQuotas() throws Exception {
		assertThat(getPath("/api/turn-credentials").statusCode()).isEqualTo(405);
		HttpResponse<String> crossOrigin = post(
				"198.51.100.20", "https://attacker.example", null);
		HttpResponse<String> forgedOriginWithCrossSiteMetadata = post(
				"198.51.100.20", origin(), "cross-site");
		HttpResponse<String> missingOrigin = post("198.51.100.20", null, null);

		assertThat(crossOrigin.statusCode()).isEqualTo(403);
		assertThat(crossOrigin.headers().firstValue("cache-control"))
				.hasValueSatisfying(value -> assertThat(value).contains("no-store"));
		assertThat(forgedOriginWithCrossSiteMetadata.statusCode()).isEqualTo(403);
		assertThat(missingOrigin.statusCode()).isEqualTo(403);

		HttpResponse<String> first = post("198.51.100.10");
		HttpResponse<String> second = post("198.51.100.10");
		HttpResponse<String> limited = post("198.51.100.10");
		HttpResponse<String> otherClient = post("198.51.100.11");
		HttpResponse<String> anotherClient = post("198.51.100.12");
		HttpResponse<String> globallyLimited = post("198.51.100.13");
		HttpResponse<String> metric = getPath(
				"/actuator/metrics/round.turn.credentials.rate_limited");
		JsonNode firstCredentials = new ObjectMapper().readTree(first.body());
		JsonNode secondCredentials = new ObjectMapper().readTree(second.body());
		JsonNode metricBody = new ObjectMapper().readTree(metric.body());

		assertThat(first.statusCode()).isEqualTo(200);
		assertThat(first.headers().firstValue("cache-control"))
				.hasValueSatisfying(value -> assertThat(value).contains("no-store"));
		assertThat(second.statusCode()).isEqualTo(200);
		assertThat(secondCredentials.get("username").asString())
				.isNotEqualTo(firstCredentials.get("username").asString());
		assertThat(secondCredentials.get("credential").asString())
				.isNotEqualTo(firstCredentials.get("credential").asString());
		assertThat(firstCredentials.at("/urls/0").asString())
				.isEqualTo("turn:turn.cloudflare.com:3478?transport=udp");
		assertThat(firstCredentials.at("/urls/1").asString())
				.isEqualTo("turns:turn.cloudflare.com:443?transport=tcp");
		assertThat(firstCredentials.get("username").asString())
				.startsWith("provider-user-");
		assertThat(firstCredentials.get("refreshAfterSeconds").asLong())
				.isEqualTo(3_300);
		assertThat(firstCredentials.get("credential").asString())
				.startsWith("provider-credential-");
		assertThat(firstCredentials.has("sharedSecret")).isFalse();

		assertThat(limited.statusCode()).isEqualTo(429);
		assertThat(limited.headers().firstValue("cache-control"))
				.hasValueSatisfying(value -> assertThat(value).contains("no-store"));
		assertThat(limited.headers().firstValue("retry-after")
				.map(Long::parseLong))
				.hasValueSatisfying(seconds -> assertThat(seconds).isBetween(1L, 60L));
		assertThat(limited.body()).isEmpty();
		assertThat(otherClient.statusCode()).isEqualTo(200);
		assertThat(anotherClient.statusCode()).isEqualTo(200);
		assertThat(globallyLimited.statusCode()).isEqualTo(429);
		assertThat(globallyLimited.headers().firstValue("cache-control"))
				.hasValueSatisfying(value -> assertThat(value).contains("no-store"));
		assertThat(globallyLimited.headers().firstValue("retry-after")
				.map(Long::parseLong))
				.hasValueSatisfying(seconds -> assertThat(seconds).isBetween(1L, 60L));
		assertThat(globallyLimited.body()).isEmpty();
		assertThat(metric.statusCode()).isEqualTo(200);
		assertThat(metricBody.at("/measurements/0/value").asDouble()).isEqualTo(2);
	}

	private HttpResponse<String> post(String forwardedFor) throws Exception {
		return post(forwardedFor, origin(), "same-origin");
	}

	private HttpResponse<String> post(
			String forwardedFor,
			String origin,
			String fetchSite) throws Exception {
		HttpRequest.Builder request = HttpRequest.newBuilder()
				.uri(URI.create(origin() + "/api/turn-credentials"))
				.header("X-Forwarded-For", forwardedFor);
		if (origin != null) {
			request.header("Origin", origin);
		}
		if (fetchSite != null) {
			request.header("Sec-Fetch-Site", fetchSite);
		}
		return HttpClient.newHttpClient()
				.send(
						request.POST(HttpRequest.BodyPublishers.noBody()).build(),
						HttpResponse.BodyHandlers.ofString());
	}

	private String origin() {
		return "http://127.0.0.1:" + port;
	}

	private HttpResponse<String> getPath(String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(origin() + path))
				.GET()
				.build();
		return HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());
	}
}
