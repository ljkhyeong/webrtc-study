package com.personal.round.config;

import static com.personal.round.config.RoundRoutes.BATON_SIGNAL_TEMPLATE;
import static com.personal.round.config.RoundRoutes.STANDALONE_SIGNAL;

import com.personal.round.auth.RoundAuthProperties;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingService;
import com.personal.round.signaling.SignalingWebSocketHandler;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import java.util.List;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import tools.jackson.databind.ObjectMapper;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

	private final SignalingWebSocketHandler handler;
	private final String[] allowedOrigins;
	private final ClientCompatibilityHandshakeInterceptor compatibilityInterceptor;
	private final ConnectionAdmissionHandshakeHandler admissionHandler;
	private final boolean batonMode;

	public WebSocketConfig(
			SignalingWebSocketHandler handler,
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy,
			SignalingProperties properties,
			RoundAuthProperties authProperties,
			Environment environment,
			ObjectMapper objectMapper) {
		this.handler = handler;
		boolean production = environment.acceptsProfiles(Profiles.of("production"));
		boolean batonMode = authProperties.batonMode();
		List<String> allowedOrigins = AllowedOrigins.validate(properties.allowedOrigins(),
				AllowedOrigins.SecurityMode.from(production, batonMode));
		this.allowedOrigins = allowedOrigins.toArray(String[]::new);
		this.compatibilityInterceptor = new ClientCompatibilityHandshakeInterceptor(allowedOrigins, objectMapper);
		this.admissionHandler =
				new ConnectionAdmissionHandshakeHandler(
						signalingService,
						admissionPolicy,
						new DefaultHandshakeHandler());
		this.batonMode = batonMode;
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		// Spring이 마지막 인터셉터로 Origin을 검사한다. Origin이 없거나 같은 출처인 요청은 허용한다.
		registry.addHandler(handler, batonMode ? BATON_SIGNAL_TEMPLATE : STANDALONE_SIGNAL)
				.addInterceptors(compatibilityInterceptor)
				.setHandshakeHandler(admissionHandler)
				.setAllowedOrigins(allowedOrigins);
	}

	@Bean
	ServletServerContainerFactoryBean webSocketContainer() {
		ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
		container.setMaxTextMessageBufferSize(ProtocolParser.MAX_SIGNALING_FRAME_BYTES);
		return container;
	}
}
