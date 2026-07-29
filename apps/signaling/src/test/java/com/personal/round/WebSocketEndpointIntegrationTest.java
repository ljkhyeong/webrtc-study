package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.signaling.allowed-origins=http://localhost:5173",
			"round.signaling.max-connections-per-client=1",
			"round.signaling.heartbeat-interval=60s"
		})
class WebSocketEndpointIntegrationTest {

	private static final String ALLOWED_ORIGIN = "http://localhost:5173";

	@LocalServerPort
	private int port;

	@Test
	void enforcesOriginPathAndPerClientAdmissionAtTheWebSocketBoundary() throws Exception {
		StandardWebSocketClient client = new StandardWebSocketClient();
		assertThatThrownBy(() -> connect(client, "/signal", "https://evil.example"))
				.hasRootCauseInstanceOf(Exception.class);

		WebSocketSession session = connect(client, "/signal?invite=room", ALLOWED_ORIGIN);
		assertThat(session.isOpen()).isTrue();
		assertThatThrownBy(() -> connect(client, "/signal", ALLOWED_ORIGIN))
				.hasRootCauseInstanceOf(Exception.class);
		session.close();

		assertThatThrownBy(() -> connect(client, "/signal/", ALLOWED_ORIGIN))
				.hasRootCauseInstanceOf(Exception.class);
	}

	private WebSocketSession connect(
			StandardWebSocketClient client,
			String path,
			String origin) throws Exception {
		WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
		headers.setOrigin(origin);
		WebSocketHandler handler = new TextWebSocketHandler();
		return client.execute(
						handler,
						headers,
						URI.create("ws://127.0.0.1:" + port + path))
				.get(2, TimeUnit.SECONDS);
	}
}
