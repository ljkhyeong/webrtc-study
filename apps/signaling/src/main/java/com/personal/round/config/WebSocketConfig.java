package com.personal.round.config;

import static com.personal.round.config.RoundRoutes.BATON_SIGNAL_TEMPLATE;
import static com.personal.round.config.RoundRoutes.STANDALONE_SIGNAL;

import com.personal.round.auth.ParticipationGrantHandshakeInterceptor;
import com.personal.round.auth.ParticipationGrantResolver;
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
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistration;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import tools.jackson.databind.ObjectMapper;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

	private final SignalingWebSocketHandler handler;
	private final OriginHandshakeInterceptor originInterceptor;
	private final ClientCompatibilityHandshakeInterceptor compatibilityInterceptor;
	private final ParticipationGrantHandshakeInterceptor grantInterceptor;
	private final ConnectionAdmissionHandshakeHandler admissionHandler;
	private final boolean batonMode;

	public WebSocketConfig(
			SignalingWebSocketHandler handler,
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy,
			SignalingProperties properties,
			RoundAuthProperties authProperties,
			ParticipationGrantResolver grantResolver,
			Environment environment,
			ObjectMapper objectMapper) {
		this.handler = handler;
		boolean production = environment.acceptsProfiles(Profiles.of("production"));
		boolean batonMode = authProperties.batonMode();
		OriginPolicy originPolicy = new OriginPolicy(properties.allowedOrigins(),
				OriginPolicy.SecurityMode.from(production, batonMode));
		this.originInterceptor = new OriginHandshakeInterceptor(originPolicy);
		this.compatibilityInterceptor = new ClientCompatibilityHandshakeInterceptor(originPolicy, objectMapper);
		this.grantInterceptor = new ParticipationGrantHandshakeInterceptor(grantResolver);
		this.admissionHandler =
				new ConnectionAdmissionHandshakeHandler(
						signalingService,
						admissionPolicy,
						new DefaultHandshakeHandler());
		this.batonMode = batonMode;
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		WebSocketHandlerRegistration registration = batonMode
				? registry.addHandler(handler, BATON_SIGNAL_TEMPLATE)
						.addInterceptors(grantInterceptor, compatibilityInterceptor, originInterceptor)
				: registry.addHandler(handler, STANDALONE_SIGNAL)
						.addInterceptors(compatibilityInterceptor, originInterceptor);
		registration.setHandshakeHandler(admissionHandler)
				.setAllowedOriginPatterns("*");
	}

	@Bean
	ServletServerContainerFactoryBean webSocketContainer() {
		ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
		container.setMaxTextMessageBufferSize(ProtocolParser.MAX_SIGNALING_FRAME_BYTES);
		container.setMaxBinaryMessageBufferSize(ProtocolParser.MAX_SIGNALING_FRAME_BYTES);
		return container;
	}
}
