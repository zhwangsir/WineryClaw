"""Round S (tenth batch): S15 Memory Freshness Signal 单元测试"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock

from chat.chat_engine import ChatEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_memory():
    mem = MagicMock()
    mem.store = AsyncMock(return_value={"ok": True})
    mem.query = AsyncMock(return_value=[])
    mem.get_top_l4 = AsyncMock(return_value=[])
    return mem


@pytest.fixture
def mock_sub_brain():
    sb = MagicMock()
    sb.execute_tool = AsyncMock(return_value="tool-result")
    return sb


@pytest.fixture
def engine(mock_memory, mock_sub_brain):
    e = ChatEngine(
        memory_manager=mock_memory,
        sub_brain_client=mock_sub_brain,
        llm_config={},
    )
    # 只关注 S15，关闭其余功能减少干扰
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = False
    e.mem_confidence_enabled = False
    e.mem_tiered_enabled = False
    e.l4_anchor_enabled = False
    e.temporal_context_enabled = False
    e.mem_freshness_enabled = True
    e.mem_freshness_fresh_days = 7
    e.mem_freshness_stale_days = 30
    return e


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _mem_with_ts(days_ago: float, **extra) -> dict:
    """构造一条距今 days_ago 天创建的记忆记录。"""
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    return {"content": "test fact", "importance": 0.5, "created_at": ts, **extra}


# ---------------------------------------------------------------------------
# S15: 记忆时效信号测试
# ---------------------------------------------------------------------------

class TestMemoryFreshnessSignal:
    """_compute_memory_freshness_line 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """mem_freshness_enabled=False 时返回空字符串。"""
        engine.mem_freshness_enabled = False
        result = engine._compute_memory_freshness_line([_mem_with_ts(1)])
        assert result == ""

    def test_returns_empty_for_empty_list(self, engine):
        """relevant 为空时返回空字符串（无记忆，不需要时效标注）。"""
        result = engine._compute_memory_freshness_line([])
        assert result == ""

    def test_fresh_memories_high(self, engine):
        """全部记忆在 fresh_days (7) 内 → 时效: 高。"""
        relevant = [_mem_with_ts(1), _mem_with_ts(3), _mem_with_ts(5)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 高" in result

    def test_medium_memories_within_stale_days(self, engine):
        """平均年龄在 fresh_days(7) ~ stale_days(30) 之间 → 时效: 中。"""
        # avg = (10 + 20) / 2 = 15 天（在 7..30 之间）
        relevant = [_mem_with_ts(10), _mem_with_ts(20)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 中" in result

    def test_stale_memories_low(self, engine):
        """平均年龄超过 stale_days (30) → 时效: 低。"""
        relevant = [_mem_with_ts(45), _mem_with_ts(60)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 低" in result

    def test_all_missing_created_at_returns_empty(self, engine):
        """全部记忆均无 created_at（如 S13 注入的 L4 锚定条目）时，跳过信号返回空字符串。

        S13 有时注入无 created_at 的 L4 记忆。若全部无时间戳仍发出"低时效"信号，
        会误导 AI 对高重要度的 L4 身份事实保持不必要的怀疑。修复后直接跳过。
        """
        relevant = [
            {"content": "L4 identity fact", "importance": 0.9},
            {"content": "another L4", "importance": 0.85},
        ]
        result = engine._compute_memory_freshness_line(relevant)
        assert result == ""

    def test_mixed_missing_created_at_uses_stale_fallback(self, engine):
        """部分缺失 created_at 时，缺失项用 stale_days+1 兜底拉低时效（仍输出信号）。"""
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        has_ts = {"content": "recent fact", "importance": 0.8,
                  "created_at": (now - timedelta(days=1)).isoformat()}
        no_ts = {"content": "no timestamp", "importance": 0.9}
        result = engine._compute_memory_freshness_line([has_ts, no_ts])
        # 有至少 1 个有效时间戳，信号应被输出（混合后拉低到"低"或"中"）
        assert result != ""
        assert result.startswith("[记忆时效:")

    def test_line_starts_with_bracket(self, engine):
        """返回行以 '[记忆时效:' 开头。"""
        result = engine._compute_memory_freshness_line([_mem_with_ts(1)])
        assert result.startswith("[记忆时效:")

    def test_line_contains_days_info(self, engine):
        """返回行包含平均天数信息。"""
        result = engine._compute_memory_freshness_line([_mem_with_ts(2)])
        assert "天前" in result

    def test_fresh_boundary_exact(self, engine):
        """恰好等于 fresh_days（7天）时，边界值归入较保守级别 → 时效: 中。

        实现使用严格 < 比较；avg_age==7.0 不满足 <7，归入"中"范围。
        """
        relevant = [_mem_with_ts(7.0)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 中" in result

    def test_just_below_fresh_boundary(self, engine):
        """略低于 fresh_days（6.9天）时，算作时效: 高。"""
        relevant = [_mem_with_ts(6.9)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 高" in result

    def test_stale_boundary_exact(self, engine):
        """恰好等于 stale_days（30天）时，边界值归入较保守级别 → 时效: 低。

        实现使用严格 < 比较；avg_age==30.0 不满足 <30，归入"低"范围。
        """
        relevant = [_mem_with_ts(30.0)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 低" in result

    def test_custom_thresholds(self, engine):
        """可通过 mem_freshness_fresh_days / stale_days 自定义阈值。"""
        engine.mem_freshness_fresh_days = 1
        engine.mem_freshness_stale_days = 3
        # 2 天 → 在 1..3 之间 → 中
        relevant = [_mem_with_ts(2)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 中" in result

    def test_mixed_ages_uses_average(self, engine):
        """混合年龄取平均值判断时效。"""
        # 1天 + 60天 → avg = 30.5 → 略超过 stale_days=30 → 低
        relevant = [_mem_with_ts(1), _mem_with_ts(60)]
        result = engine._compute_memory_freshness_line(relevant)
        assert "时效: 低" in result

    def test_invalid_timestamp_all_invalid_skips_signal(self, engine):
        """全部 created_at 格式无效时，与全部缺失行为一致：返回空字符串（无有效时间基准）。"""
        relevant = [{"content": "bad ts", "importance": 0.5, "created_at": "not-a-date"}]
        result = engine._compute_memory_freshness_line(relevant)
        # 无有效时间戳 → 跳过信号，与全部无 created_at 行为一致
        assert result == ""

    def test_invalid_timestamp_mixed_with_valid_uses_stale_fallback(self, engine):
        """部分 created_at 格式无效时，无效项用 stale 兜底，有效项正常计算，仍输出信号。"""
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        valid = {"content": "ok", "importance": 0.8,
                 "created_at": (now - timedelta(days=2)).isoformat()}
        invalid = {"content": "bad ts", "importance": 0.5, "created_at": "not-a-date"}
        result = engine._compute_memory_freshness_line([valid, invalid])
        # 有 1 个有效时间戳 → 仍输出信号
        assert result.startswith("[记忆时效:")

    def test_s11_and_s15_both_appear_in_memory_text(self, engine):
        """启用 S11+S15 时，memory_text 同时包含置信度和时效两行元信号。"""
        engine.mem_confidence_enabled = True
        engine.mem_confidence_threshold = 0.7
        relevant = [_mem_with_ts(2, importance=0.9)]
        # S11
        conf_line = engine._compute_memory_confidence_line(relevant)
        # S15
        freshness_line = engine._compute_memory_freshness_line(relevant)
        assert "[记忆支撑:" in conf_line
        assert "[记忆时效:" in freshness_line
        # 两行不同
        assert conf_line != freshness_line

    def test_invalid_env_fallback(self, mock_memory, mock_sub_brain):
        """WEBRAIN_MEM_FRESHNESS_*_DAYS 非法值时启动不崩溃，使用默认 7/30。"""
        import os
        orig_fresh = os.environ.get("WEBRAIN_MEM_FRESHNESS_FRESH_DAYS")
        orig_stale = os.environ.get("WEBRAIN_MEM_FRESHNESS_STALE_DAYS")
        try:
            os.environ["WEBRAIN_MEM_FRESHNESS_FRESH_DAYS"] = "bad_value"
            os.environ["WEBRAIN_MEM_FRESHNESS_STALE_DAYS"] = "also_bad"
            e = ChatEngine(memory_manager=mock_memory, sub_brain_client=mock_sub_brain, llm_config={})
            assert e.mem_freshness_fresh_days == 7
            assert e.mem_freshness_stale_days == 30
        finally:
            for key, orig in [
                ("WEBRAIN_MEM_FRESHNESS_FRESH_DAYS", orig_fresh),
                ("WEBRAIN_MEM_FRESHNESS_STALE_DAYS", orig_stale),
            ]:
                if orig is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = orig
