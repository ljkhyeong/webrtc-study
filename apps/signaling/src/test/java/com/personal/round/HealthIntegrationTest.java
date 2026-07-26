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
			"round.signaling.heartbeat-interval-ms=60000"
		})
class HealthIntegrationTest {

	@LocalServerPort
	private int port;

	@Test
	void exposesNoStoreHealthEndpoint() throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create("http://127.0.0.1:" + port + "/healthz"))
				.GET()
				.build();

		HttpResponse<String> response = HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("cache-control")).contains("no-store");
		assertThat(response.body()).isEqualTo("{\"status\":\"ok\"}");
	}
}
