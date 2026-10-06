package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.protocol.ClientMessage;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class SignalingServiceHandTest extends SignalingServiceTestSupport {
	@Test
	void 방의_모든_참가자에게_같은_대기순서를_보내고_조회는_요청한_참가자에게만_응답한다() throws Exception {
		TestPeer a = peer("a");
		TestPeer b = peer("b");
		TestPeer c = peer("c");
		connect(a, b, c);
		service.handle(a.session(), join("가온"));
		String aId = a.nextJson().at("/payload/peerId").asString();
		service.handle(b.session(), join("나래"));
		String bId = b.nextJson().at("/payload/peerId").asString();
		a.nextJson();
		service.handle(c.session(), join("다온"));
		c.nextJson();
		a.nextJson();
		b.nextJson();

		service.handle(b.session(), hand(null));
		assertThat(b.nextJson().at("/payload/peerIds").size()).isZero();
		service.handle(b.session(), hand(true));
		for (TestPeer target : List.of(a, b, c)) {
			// 조회 응답은 b에게만 보내므로 a와 c가 처음 받는 손들기 상태는 b의 변경이다.
			assertThat(target.nextJson().at("/payload/peerIds").toString()).isEqualTo(ids(bId));
		}
		service.handle(a.session(), hand(true));
		var first = a.nextJson();
		assertThat(first.at("/payload/peerIds").toString()).isEqualTo(ids(bId, aId));
		assertThat(b.nextJson().get("payload")).isEqualTo(first.get("payload"));
		assertThat(c.nextJson().get("payload")).isEqualTo(first.get("payload"));
		service.handle(a.session(), hand(true));
		assertThat(a.nextJson().get("payload")).isEqualTo(first.get("payload"));
		service.handle(b.session(), hand(false));
		service.handle(b.session(), hand(true));
		for (TestPeer target : List.of(a, b, c)) {
			assertThat(target.nextJson().at("/payload/peerIds").toString()).isEqualTo(ids(aId));
			assertThat(target.nextJson().at("/payload/peerIds").toString()).isEqualTo(ids(aId, bId));
		}

		service.disconnect(a.session());
		for (TestPeer target : List.of(b, c)) {
			assertThat(target.nextJson().path("type").asString()).isEqualTo("peer.left");
			assertThat(target.nextJson().at("/payload/peerIds").toString()).isEqualTo(ids(bId));
		}
		service.disconnect(b.session());
		c.nextJson();
		c.nextJson();
		service.disconnect(c.session());
		TestPeer next = peer("next");
		connect(next);
		service.handle(next.session(), join("새 참가자"));
		next.nextJson();
		service.handle(next.session(), hand(null));
		var state = next.nextJson();
		assertThat(state.at("/payload/peerIds").size()).isZero();
	}

	@Test
	void 미입장자와_다른_방의_요청을_거부한다() throws Exception {
		TestPeer a = peer("a");
		connect(a);
		service.handle(a.session(), hand(true));
		assertError(a.nextJson(), "NOT_IN_ROOM");
		service.handle(a.session(), join("가온"));
		a.nextJson();
		service.handle(a.session(), new ClientMessage.Hand("bcde-fghj-kmnp", null, true));
		assertError(a.nextJson(), "ROOM_MISMATCH");
		service.handle(a.session(), hand(null));
		assertThat(a.nextJson().at("/payload/peerIds").size()).isZero();
	}

	private ClientMessage.Hand hand(Boolean raised) {
		return new ClientMessage.Hand(ROOM_ID, null, raised);
	}

	private static String ids(String... peerIds) {
		return Arrays.stream(peerIds)
				.map(peerId -> "\"" + peerId + "\"")
				.collect(Collectors.joining(",", "[", "]"));
	}
}
