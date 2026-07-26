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
			"server.tomcat.remoteip.internal-proxies=172.16.0.0/12",
			"round.signaling.heartbeat-interval-ms=60000",
			"round.turn.urls=turn:turn.example.com:3478",
			"round.turn.shared-secret=integration-shared-secret",
			"round.turn.rate-limit-window-seconds=60",
			"round.turn.rate-limit-max-requests=2"
		})
class TurnCredentialUntrustedForwardingIntegrationTest {

	@LocalServerPort
	private int port;

	@Test
	void ignoresForwardedAddressesFromAnUntrustedDirectPeer() throws Exception {
		assertThat(get("198.51.100.1").statusCode()).isEqualTo(200);
		assertThat(get("198.51.100.2").statusCode()).isEqualTo(200);
		assertThat(get("198.51.100.3").statusCode()).isEqualTo(429);
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
}
