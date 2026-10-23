"""Tests for workload module."""

from datetime import date, timedelta

from arete.features.workload import (
    ACWRZone,
    DailyLoad,
    MonotonyZone,
    StrainZone,
    calculate_acute_load,
    calculate_acwr,
    calculate_acwr_ewma,
    calculate_chronic_load,
    calculate_ewma_load,
    calculate_load_change_percent,
    calculate_monotony,
    calculate_strain,
    calculate_training_load,
    compute_workload_metrics,
    get_acwr_zone,
    get_monotony_zone,
    get_safe_load_increase,
    get_strain_zone,
    validate_rpe,
)


class TestTrainingLoad:
    """Tests for training load calculation."""

    def test_basic_calculation(self) -> None:
        """Test basic sRPE calculation."""
        assert calculate_training_load(60, 7) == 420.0
        assert calculate_training_load(30, 5) == 150.0

    def test_zero_duration(self) -> None:
        """Zero duration gives zero load."""
        assert calculate_training_load(0, 10) == 0.0

    def test_zero_rpe(self) -> None:
        """Zero RPE gives zero load."""
        assert calculate_training_load(60, 0) == 0.0


class TestAcuteLoad:
    """Tests for acute load calculation."""

    def test_seven_day_sum(self) -> None:
        """Acute load is sum of last 7 days."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(7)
        ]
        acute = calculate_acute_load(loads, today)
        assert acute == 7 * 300  # 7 days × (60 × 5)

    def test_excludes_older_data(self) -> None:
        """Data older than 7 days is excluded."""
        today = date.today()
        loads = [DailyLoad(date=today - timedelta(days=10), duration_min=60, rpe=10)]
        acute = calculate_acute_load(loads, today)
        assert acute == 0.0

    def test_empty_loads(self) -> None:
        """Empty loads gives zero."""
        assert calculate_acute_load([], date.today()) == 0.0


class TestChronicLoad:
    """Tests for chronic load calculation."""

    def test_four_week_average(self) -> None:
        """Chronic load is average of 4 weekly loads."""
        today = date.today()
        # Create 28 days of data, each day has load of 300
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(28)
        ]
        chronic = calculate_chronic_load(loads, today)
        # 7 days per week × 300 = 2100 per week, avg = 2100
        assert chronic == 2100.0

    def test_empty_loads(self) -> None:
        """Empty loads gives zero."""
        assert calculate_chronic_load([], date.today()) == 0.0


class TestACWR:
    """Tests for ACWR calculation."""

    def test_basic_ratio(self) -> None:
        """ACWR = acute / chronic."""
        assert calculate_acwr(2100, 2100) == 1.0
        assert calculate_acwr(2100, 1400) == 1.5

    def test_zero_chronic(self) -> None:
        """Zero chronic gives None."""
        assert calculate_acwr(100, 0) is None

    def test_both_zero(self) -> None:
        """Both zero gives None."""
        assert calculate_acwr(0, 0) is None


class TestACWRZones:
    """Tests for ACWR zone classification."""

    def test_undertrained(self) -> None:
        """ACWR < 0.8 is undertrained."""
        assert get_acwr_zone(0.5) == ACWRZone.UNDERTRAINED
        assert get_acwr_zone(0.79) == ACWRZone.UNDERTRAINED

    def test_optimal(self) -> None:
        """ACWR 0.8-1.3 is optimal."""
        assert get_acwr_zone(0.8) == ACWRZone.OPTIMAL
        assert get_acwr_zone(1.0) == ACWRZone.OPTIMAL
        assert get_acwr_zone(1.3) == ACWRZone.OPTIMAL

    def test_caution(self) -> None:
        """ACWR 1.3-1.5 is caution."""
        assert get_acwr_zone(1.31) == ACWRZone.CAUTION
        assert get_acwr_zone(1.5) == ACWRZone.CAUTION

    def test_danger(self) -> None:
        """ACWR > 1.5 is danger."""
        assert get_acwr_zone(1.51) == ACWRZone.DANGER
        assert get_acwr_zone(2.0) == ACWRZone.DANGER

    def test_none_value(self) -> None:
        """None ACWR gives unknown zone."""
        assert get_acwr_zone(None) == ACWRZone.UNKNOWN


class TestEWMA:
    """Tests for EWMA calculations."""

    def test_ewma_load_basic(self) -> None:
        """EWMA calculation gives reasonable values."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(7)
        ]
        ewma = calculate_ewma_load(loads, today, days=7)
        assert ewma > 0

    def test_acwr_ewma(self) -> None:
        """EWMA-based ACWR works."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(28)
        ]
        acwr = calculate_acwr_ewma(loads, today)
        assert acwr is not None
        assert acwr > 0


class TestMonotony:
    """Tests for training monotony."""

    def test_varied_training(self) -> None:
        """Varied training has low monotony."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=0), duration_min=60, rpe=8),
            DailyLoad(date=today - timedelta(days=1), duration_min=30, rpe=4),
            DailyLoad(date=today - timedelta(days=2), duration_min=90, rpe=6),
            DailyLoad(date=today - timedelta(days=3), duration_min=0, rpe=0),
            DailyLoad(date=today - timedelta(days=4), duration_min=45, rpe=7),
            DailyLoad(date=today - timedelta(days=5), duration_min=60, rpe=5),
            DailyLoad(date=today - timedelta(days=6), duration_min=0, rpe=0),
        ]
        monotony = calculate_monotony(loads, today)
        assert monotony is not None
        assert monotony < 2.0  # Should be reasonably varied

    def test_identical_training(self) -> None:
        """Identical training daily has high monotony."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(7)
        ]
        monotony = calculate_monotony(loads, today)
        # All same loads means std = 0, returns None
        assert monotony is None

    def test_statistics_error_returns_none(self, monkeypatch) -> None:
        """A StatisticsError from stdev/mean is the only expected failure; it yields None."""
        import arete.features.workload as workload

        def _raise(*args: object, **kwargs: object) -> None:
            raise workload.StatisticsError("no data points")

        monkeypatch.setattr(workload, "stdev", _raise)
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            for i in range(7)
        ]
        assert calculate_monotony(loads, today) is None

    def test_monotony_zones(self) -> None:
        """Test monotony zone classification."""
        assert get_monotony_zone(1.0) == MonotonyZone.IDEAL
        assert get_monotony_zone(1.5) == MonotonyZone.ACCEPTABLE
        assert get_monotony_zone(2.0) == MonotonyZone.ACCEPTABLE
        assert get_monotony_zone(2.5) == MonotonyZone.HIGH
        assert get_monotony_zone(None) is None


class TestStrain:
    """Tests for training strain."""

    def test_basic_strain(self) -> None:
        """Strain = weekly load × monotony."""
        assert calculate_strain(2000, 1.5) == 3000.0
        assert calculate_strain(3000, 2.0) == 6000.0

    def test_none_monotony(self) -> None:
        """None monotony gives None strain."""
        assert calculate_strain(2000, None) is None

    def test_strain_zones(self) -> None:
        """Test strain zone classification."""
        assert get_strain_zone(1500) == StrainZone.LOW
        assert get_strain_zone(3000) == StrainZone.OPTIMAL
        assert get_strain_zone(5000) == StrainZone.HIGH
        assert get_strain_zone(7000) == StrainZone.CRITICAL
        assert get_strain_zone(None) is None


class TestComputeWorkloadMetrics:
    """Tests for complete workload metrics computation."""

    def test_complete_metrics(self) -> None:
        """compute_workload_metrics returns all fields."""
        today = date.today()
        loads = [
            DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5 + (i % 3))
            for i in range(28)
        ]
        metrics = compute_workload_metrics(loads, today)

        assert metrics.date == today
        assert metrics.acute_load > 0
        assert metrics.chronic_load > 0
        assert metrics.acwr is not None
        assert metrics.acwr_zone in ACWRZone
        assert metrics.acwr_ewma is not None


class TestUtilityFunctions:
    """Tests for utility functions."""

    def test_load_change_percent(self) -> None:
        """Test week-over-week change calculation."""
        today = date.today()
        # Week 1: load 300 each day, Week 2 (current): load 330 each day
        loads = []
        for i in range(7):
            loads.append(
                DailyLoad(date=today - timedelta(days=i), duration_min=66, rpe=5)
            )
        for i in range(7, 14):
            loads.append(
                DailyLoad(date=today - timedelta(days=i), duration_min=60, rpe=5)
            )

        change = calculate_load_change_percent(loads, today)
        assert change is not None
        assert change > 0  # Current week has higher load

    def test_safe_load_increase(self) -> None:
        """Test safe load calculation."""
        chronic = 2000.0
        safe = get_safe_load_increase(chronic, max_acwr=1.3)
        assert safe == 2600.0  # 2000 × 1.3

    def test_validate_rpe(self) -> None:
        """Test RPE validation."""
        assert validate_rpe(0) is True
        assert validate_rpe(5) is True
        assert validate_rpe(10) is True
        assert validate_rpe(-1) is False
        assert validate_rpe(11) is False
