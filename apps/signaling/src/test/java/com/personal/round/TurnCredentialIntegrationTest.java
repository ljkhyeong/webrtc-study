package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.signaling.heartbeat-interval-ms=60000",
			"round.turn.urls=turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp",
			"round.turn.shared-secret=integration-shared-secret",
			"round.turn.credential-ttl-seconds=3600",
			"round.turn.rate-limit-window-seconds=60",
			"round.turn.rate-limit-max-requests=2"
		})
class TurnCredentialIntegrationTest {

	@LocalServerPort
	private int port;

	@Test
	void issuesUniqueCredentialsAndRateLimitsTheForwardedClientAddress() throws Exception {
		HttpResponse<String> first = get("198.51.100.10");
		HttpResponse<String> second = get("198.51.100.10");
		HttpResponse<String> limited = get("198.51.100.10");
		HttpResponse<String> otherClient = get("198.51.100.11");
		HttpResponse<String> metric = getPath(
				"/actuator/metrics/round.turn.credentials.rate_limited");
		JsonNode firstCredentials = new ObjectMapper().readTree(first.body());
		JsonNode secondCredentials = new ObjectMapper().readTree(second.body());
		JsonNode metricBody = new ObjectMapper().readTree(metric.body());

		assertThat(first.statusCode()).isEqualTo(200);
		assertThat(first.headers().firstValue("cache-control")).contains("no-store");
		assertThat(second.statusCode()).isEqualTo(200);
		assertThat(secondCredentials.get("username").asText())
				.isNotEqualTo(firstCredentials.get("username").asText());
		assertThat(secondCredentials.get("credential").asText())
				.isNotEqualTo(firstCredentials.get("credential").asText());
		assertThat(firstCredentials.at("/urls/0").asText())
				.isEqualTo("turn:turn.example.com:3478");
		assertThat(firstCredentials.at("/urls/1").asText())
				.isEqualTo("turns:turn.example.com:5349?transport=tcp");
		assertThat(firstCredentials.get("username").asText())
				.startsWith(firstCredentials.get("expiresAt").asLong() + ":");
		assertThat(firstCredentials.get("credential").asText())
				.isNotBlank()
				.doesNotContain("integration-shared-secret");
		assertThat(firstCredentials.has("sharedSecret")).isFalse();

		assertThat(limited.statusCode()).isEqualTo(429);
		assertThat(limited.headers().firstValue("cache-control")).contains("no-store");
		assertThat(limited.headers().firstValue("retry-after")
				.map(Long::parseLong))
				.hasValueSatisfying(seconds -> assertThat(seconds).isBetween(1L, 60L));
		assertThat(limited.body()).isEmpty();
		assertThat(otherClient.statusCode()).isEqualTo(200);
		assertThat(metric.statusCode()).isEqualTo(200);
		assertThat(metricBody.at("/measurements/0/value").asDouble()).isEqualTo(1);
	}

	private HttpResponse<String> get(String forwardedFor) throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create("http://127.0.0.1:" + port + "/api/turn-credentials"))
				.header("X-Forwarded-For", forwardedFor)
				.GET()
				.build();
		return HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());
	}

	private HttpResponse<String> getPath(String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create("http://127.0.0.1:" + port + path))
				.GET()
				.build();
		return HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());
	}
}
