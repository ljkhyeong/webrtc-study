package com.personal.round;

import static com.tngtech.archunit.core.domain.JavaClass.Predicates.resideInAnyPackage;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.resideOutsideOfPackage;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.simpleNameEndingWith;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.stereotype.Repository;
import org.springframework.web.bind.annotation.RestController;

@AnalyzeClasses(
		packages = "com.personal.round",
		importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

	private static final DescribedPredicate<JavaClass> CONCRETE_SPRING_REPOSITORIES =
			DescribedPredicate.describe(
					"Spring @Repository 구현체",
					candidate ->
							!candidate.isInterface()
									&& (candidate.isAnnotatedWith(Repository.class)
											|| candidate.isMetaAnnotatedWith(Repository.class)));

	private static final DescribedPredicate<JavaClass> REPOSITORY_TYPES =
			simpleNameEndingWith("Repository")
					.or(CONCRETE_SPRING_REPOSITORIES)
					.as("Repository 인터페이스 또는 구현체");

	private static final DescribedPredicate<JavaClass> WEBSOCKET_HANDLER_DEPENDENCIES =
			resideOutsideOfPackage("com.personal.round..")
					.or(resideInAnyPackage(
							"com.personal.round.protocol..",
							"com.personal.round.signaling.."))
					.as("외부 라이브러리 또는 ROUND 프로토콜과 시그널링 클래스");

	@ArchTest
	static final ArchRule PROTOCOL_DOES_NOT_DEPEND_ON_OUTER_LAYERS =
			noClasses()
					.that()
					.resideInAPackage("com.personal.round.protocol..")
					.should()
					.dependOnClassesThat()
					.resideInAnyPackage(
							"com.personal.round.config..",
							"com.personal.round.health..",
							"com.personal.round.net..",
							"com.personal.round.signaling..",
							"com.personal.round.turn..")
					.because("프로토콜은 전송과 실행 계층에 의존하지 않아야 한다");

	@ArchTest
	static final ArchRule AUTH_DOES_NOT_DEPEND_ON_RUNTIME_FEATURES =
			noClasses()
					.that()
					.resideInAPackage("com.personal.round.auth..")
					.should()
					.dependOnClassesThat()
					.resideInAnyPackage(
							"com.personal.round.health..",
							"com.personal.round.signaling..",
							"com.personal.round.turn..")
					.because("인증은 통화 실행 기능에 의존하지 않아야 한다");

	@ArchTest
	static final ArchRule CONTROLLERS_DO_NOT_ACCESS_REPOSITORIES =
			noClasses()
					.that()
					.areAnnotatedWith(RestController.class)
					.should()
					.dependOnClassesThat(REPOSITORY_TYPES)
					.because("컨트롤러는 저장소 대신 서비스에 의존해야 한다");

	@ArchTest
	static final ArchRule SERVICES_DO_NOT_DEPEND_ON_REPOSITORY_IMPLEMENTATIONS =
			noClasses()
					.that()
					.haveSimpleNameEndingWith("Service")
					.should()
					.dependOnClassesThat(CONCRETE_SPRING_REPOSITORIES)
					.because("서비스는 저장소 구현체 대신 포트나 인터페이스에 의존해야 한다");

	@ArchTest
	static final ArchRule WEBSOCKET_HANDLERS_USE_ONLY_SIGNALING_AND_PROTOCOL_FEATURES =
			classes()
					.that()
					.haveSimpleNameEndingWith("WebSocketHandler")
					.should()
					.onlyDependOnClassesThat(WEBSOCKET_HANDLER_DEPENDENCIES)
					.because("WebSocket 핸들러는 프로토콜 해석과 시그널링 서비스 호출만 담당해야 한다");
}
