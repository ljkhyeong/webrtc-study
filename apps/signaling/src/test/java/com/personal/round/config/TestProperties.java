package com.personal.round.config;

import com.personal.round.auth.RoundAuthProperties;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.bind.BindHandler;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.PropertySourcesPlaceholdersResolver;
import org.springframework.boot.context.properties.bind.handler.NoUnboundElementsBindHandler;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;

/**
 * application.yml 기본값에 {@code "속성-이름=값"}으로 덮어쓴 설정을 운영과 같은 Spring Boot 바인딩 경로로 만든다.
 * 모르는 속성 이름은 바로 실패한다. Bean Validation은 실행하지 않으므로 경계 밖 값도 만들 수 있다.
 */
public final class TestProperties {

	private static final List<PropertySource<?>> APPLICATION_YAML = loadApplicationYaml();

	private TestProperties() {
	}

	public static SignalingProperties signaling(String... overrides) {
		return bind("round.signaling", SignalingProperties.class, overrides);
	}

	public static TurnProperties turn(String... overrides) {
		return bind("round.turn", TurnProperties.class, overrides);
	}

	public static RoundAuthProperties standaloneAuth() {
		return bind("round.auth", RoundAuthProperties.class);
	}

	public static RoundAuthProperties standaloneAuth(String hostTokenSha256) {
		return bind(
				"round.auth",
				RoundAuthProperties.class,
				"standalone-host-token-sha256=" + hostTokenSha256);
	}

	public static RoundAuthProperties batonAuth() {
		return bind(
				"round.auth",
				RoundAuthProperties.class,
				"mode=baton",
				"issuer=https://baton.example/oauth2",
				"jwk-set-uri=https://baton.example/oauth2/jwks");
	}

	private static <T> T bind(String prefix, Class<T> type, String... overrides) {
		Map<String, Object> values = new LinkedHashMap<>();
		for (String override : overrides) {
			int separator = override.indexOf('=');
			values.put(prefix + "." + override.substring(0, separator), override.substring(separator + 1));
		}
		MutablePropertySources sources = new MutablePropertySources();
		sources.addFirst(new MapPropertySource("test-overrides", values));
		APPLICATION_YAML.forEach(sources::addLast);
		// 자리표시자의 환경변수는 찾지 않고 application.yml의 기본값을 쓴다.
		return new Binder(
				ConfigurationPropertySources.from(sources),
				new PropertySourcesPlaceholdersResolver(sources))
				.bindOrCreate(prefix, Bindable.of(type), new NoUnboundElementsBindHandler(BindHandler.DEFAULT));
	}

	private static List<PropertySource<?>> loadApplicationYaml() {
		try {
			return new YamlPropertySourceLoader()
					.load("application.yml", new ClassPathResource("application.yml"));
		}
		catch (IOException exception) {
			throw new UncheckedIOException(exception);
		}
	}
}
