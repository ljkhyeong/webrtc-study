package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;
import com.personal.round.protocol.ClientMessage;
import org.junit.jupiter.api.Test;

class SignalingServiceStudyTest extends SignalingServiceTestSupport {
	@Test
	void synchronizesLateJoinRejectsParticipantAndPreservesFirstHostUpdate() throws Exception {
		TestPeer host = peer("host");
		TestPeer participant = peer("participant");
		connect(host, participant);
		service.handle(host.session(), new ClientMessage.Join(ROOM_ID, null, "방장", HOST_TOKEN));
		host.nextJson();
		service.handle(host.session(), update("start", 0, null, "focus", 1500));
		assertThat(host.nextJson().at("/payload/running").asBoolean()).isTrue();
		monotonicTicker.advanceMillis(5000);
		clock.advanceMillis(3_600_000);
		service.handle(participant.session(), join("참가자"));
		participant.nextJson();
		host.nextJson();
		service.handle(participant.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		var lateState = participant.nextJson();
		assertThat(lateState.at("/payload/remainingMs").asLong()).isEqualTo(1_495_000);
		service.handle(participant.session(), update("pause", 1, null, null, 0));
		assertError(participant.nextJson(), "FORBIDDEN");
		service.handle(host.session(), update("topic", 1, "코드 리뷰", null, 0));
		assertThat(host.nextJson().at("/payload/topic").asString()).isEqualTo("코드 리뷰");
		participant.nextJson();
		service.handle(host.session(), update("pause", 1, null, null, 0));
		var conflict = host.nextJson();
		assertThat(conflict.at("/payload/conflict").asBoolean()).isTrue();
		assertThat(conflict.at("/payload/running").asBoolean()).isTrue();
		service.handle(host.session(), update("pause", 2, null, null, 0));
		host.nextJson();
		participant.nextJson();
		monotonicTicker.advanceMillis(10_000);
		service.handle(participant.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		assertThat(participant.nextJson().at("/payload/remainingMs").asLong()).isEqualTo(1_495_000);
		service.handle(host.session(), update("resume", 3, null, null, 0));
		host.nextJson();
		participant.nextJson();
		service.disconnect(host.session());
		participant.nextJson();
		monotonicTicker.advanceMillis(1000);
		service.handle(participant.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		assertThat(participant.nextJson().at("/payload/remainingMs").asLong()).isEqualTo(1_494_000);
		service.disconnect(participant.session());
		// 연결이 끊겨 빈 방은 보관 시간 안에 다시 입장하면 타이머·주제를 이어 쓴다.
		monotonicTicker.advanceMillis(60_000);
		TestPeer next = peer("next");
		connect(next);
		service.handle(next.session(), join("새 참가자"));
		next.nextJson();
		service.handle(next.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		var restored = next.nextJson();
		assertThat(restored.at("/payload/revision").asLong()).isEqualTo(4);
		assertThat(restored.at("/payload/topic").asString()).isEqualTo("코드 리뷰");
		assertThat(restored.at("/payload/remainingMs").asLong()).isEqualTo(1_434_000);
	}

	@Test
	void clearsAnEmptyRoomStudyAfterAnExplicitLeaveOrOnceTheRetentionExpires() throws Exception {
		TestPeer leaving = peer("leaving-host");
		connect(leaving);
		service.handle(leaving.session(), new ClientMessage.Join(ROOM_ID, null, "방장", HOST_TOKEN));
		leaving.nextJson();
		service.handle(leaving.session(), update("topic", 0, "알고리즘", null, 0));
		leaving.nextJson();
		service.handle(leaving.session(), new ClientMessage.Leave(ROOM_ID, null));

		TestPeer disconnected = peer("disconnected-host");
		connect(disconnected);
		service.handle(disconnected.session(), new ClientMessage.Join(ROOM_ID, null, "방장", HOST_TOKEN));
		disconnected.nextJson();
		service.handle(disconnected.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		var afterLeave = disconnected.nextJson();
		assertThat(afterLeave.at("/payload/revision").asLong()).isZero();
		assertThat(afterLeave.at("/payload/topic").asString()).isEmpty();

		service.handle(disconnected.session(), update("topic", 0, "자료구조", null, 0));
		disconnected.nextJson();
		service.disconnect(disconnected.session());
		monotonicTicker.advanceMillis(600_000);

		TestPeer late = peer("late");
		connect(late);
		service.handle(late.session(), join("늦은 참가자"));
		late.nextJson();
		service.handle(late.session(), new ClientMessage.Study(ROOM_ID, "sync", null));
		var afterRetention = late.nextJson();
		assertThat(afterRetention.at("/payload/revision").asLong()).isZero();
		assertThat(afterRetention.at("/payload/topic").asString()).isEmpty();
	}

	private ClientMessage.Study update(String action, long revision, String topic, String mode, int seconds) {
		return new ClientMessage.Study(ROOM_ID, "change", new ClientMessage.StudyCommand(action, revision, topic, mode, seconds));
	}
}
