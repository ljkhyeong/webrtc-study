package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.signaling.heartbeat-interval=60s"
		})
class HealthIntegrationTest {

	@LocalServerPort
	private int port;

	@Test
	void exposesNoStoreHealthEndpoint() throws Exception {
		HttpResponse<String> response = get("/healthz");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("cache-control")).contains("no-store");
		assertThat(response.body()).isEqualTo("{\"status\":\"ok\"}");
	}

	@Test
	void exposesActuatorReadinessAndMicrometerMetrics() throws Exception {
		HttpResponse<String> readiness = get("/actuator/health/readiness");
		HttpResponse<String> metric = get(
				"/actuator/metrics/round.signaling.rooms.active");
		HttpResponse<String> prometheus = get("/actuator/prometheus");

		assertThat(readiness.statusCode()).isEqualTo(200);
		assertThat(readiness.body()).contains("\"status\":\"UP\"");
		assertThat(metric.statusCode()).isEqualTo(200);
		assertThat(metric.body()).contains("\"name\":\"round.signaling.rooms.active\"");
		assertThat(prometheus.statusCode()).isEqualTo(200);
		assertThat(prometheus.body()).contains("round_signaling_rooms_active");
	}

	@Test
	void keepsTurnCredentialEndpointHiddenWhenTurnIsDisabled() throws Exception {
		String origin = "http://127.0.0.1:" + port;
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(origin + "/api/turn-credentials"))
				.header("Origin", origin)
				.header("Sec-Fetch-Site", "same-origin")
				.POST(HttpRequest.BodyPublishers.noBody())
				.build();

		HttpResponse<String> response = HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());

		assertThat(response.statusCode()).isEqualTo(204);
		assertThat(response.headers().firstValue("cache-control")).contains("no-store");
	}

	private HttpResponse<String> get(String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create("http://127.0.0.1:" + port + path))
				.GET()
				.build();
		return HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());
	}
}
