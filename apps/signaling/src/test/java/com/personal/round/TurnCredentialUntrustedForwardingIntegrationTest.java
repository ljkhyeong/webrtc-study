package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;

import com.personal.round.turn.CloudflareTurnClient;
import com.personal.round.turn.TurnCredentialMaterial;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"server.tomcat.remoteip.internal-proxies=172.16.0.0/12",
			"round.signaling.heartbeat-interval=60s",
			"round.turn.provider=cloudflare",
			"round.turn.cloudflare-key-id=integration-key",
			"round.turn.cloudflare-api-token=integration-token",
			"round.turn.rate-limit-window=60s",
			"round.turn.rate-limit-max-requests=2"
		})
class TurnCredentialUntrustedForwardingIntegrationTest {

	@LocalServerPort
	private int port;

	@MockitoBean
	private CloudflareTurnClient cloudflareTurnClient;

	@BeforeEach
	void stubCloudflareCredentials() {
		when(cloudflareTurnClient.issue(anyLong())).thenReturn(
				new TurnCredentialMaterial(
						List.of("turn:turn.cloudflare.com:3478?transport=udp"),
						"provider-user",
						"provider-credential"));
	}

	@Test
	void ignoresForwardedAddressesFromAnUntrustedDirectPeer() throws Exception {
		assertThat(post("198.51.100.1").statusCode()).isEqualTo(200);
		assertThat(post("198.51.100.2").statusCode()).isEqualTo(200);
		assertThat(post("198.51.100.3").statusCode()).isEqualTo(429);
	}

	private HttpResponse<String> post(String forwardedFor) throws Exception {
		String origin = "http://127.0.0.1:" + port;
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(origin + "/api/turn-credentials"))
				.header("X-Forwarded-For", forwardedFor)
				.header("Origin", origin)
				.header("Sec-Fetch-Site", "same-origin")
				.POST(HttpRequest.BodyPublishers.noBody())
				.build();
		return HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofString());
	}
}
