package com.personal.round.turn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;

import com.personal.round.config.TestProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

class CloudflareTurnClientTest {

	@Test
	void requestsShortLivedCredentialsAndKeepsUsableTurnRoutes() {
		RestClient.Builder builder = RestClient.builder();
		MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
		server.expect(requestTo(
					"https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/"
							+ "generate-ice-servers"))
				.andExpect(method(HttpMethod.POST))
				.andExpect(header("Authorization", "Bearer test-token"))
				.andExpect(content().json("{\"ttl\":600}"))
				.andRespond(withStatus(HttpStatus.CREATED)
						.contentType(MediaType.APPLICATION_JSON)
						.body("""
								{
								  "iceServers": [
								    null,
								    {
								      "urls": ["stun:stun.cloudflare.com:3478"]
								    },
								    {
								      "urls": [
								        "turn:turn.cloudflare.com:3478?transport=udp",
								        "turn:turn.cloudflare.com:53?transport=udp",
								        "turn:turn.cloudflare.com:80?transport=tcp",
								        "turns:turn.cloudflare.com:443?transport=tcp"
								      ],
								      "username": "provider-user",
								      "credential": "provider-credential"
								    }
								  ]
								}
								"""));

		CloudflareTurnClient client = new CloudflareTurnClient(
				builder,
				TestProperties.turn("test-key", "test-token"));

		TurnCredentialMaterial credentials = client.issue(600);

		assertThat(credentials.urls()).containsExactly(
				"turn:turn.cloudflare.com:3478?transport=udp",
				"turn:turn.cloudflare.com:80?transport=tcp",
				"turns:turn.cloudflare.com:443?transport=tcp");
		assertThat(credentials.username()).isEqualTo("provider-user");
		assertThat(credentials.credential()).isEqualTo("provider-credential");
		server.verify();
	}

	@ParameterizedTest
	@ValueSource(strings = {
			"{\"iceServers\":[{\"urls\":[\"stun:stun.cloudflare.com:3478\"]}]}",
			"{\"iceServers\":[null]}"
	})
	void rejectsAResponseWithoutUsableTurnCredentials(String responseBody) {
		RestClient.Builder builder = RestClient.builder();
		MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
		server.expect(requestTo(
					"https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/"
							+ "generate-ice-servers"))
				.andRespond(withStatus(HttpStatus.CREATED)
						.contentType(MediaType.APPLICATION_JSON)
						.body(responseBody));
		CloudflareTurnClient client = new CloudflareTurnClient(
				builder,
				TestProperties.turn("test-key", "test-token"));

		assertThatThrownBy(() -> client.issue(600))
				.isInstanceOf(CloudflareTurnClient.ProviderUnavailableException.class);
		server.verify();
	}
}
