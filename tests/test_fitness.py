"""Tests for fitness module (Banister model)."""

from datetime import date, timedelta

from arete.features.fitness import (
    DailyTSS,
    FormZone,
    ReadinessLevel,
    calculate_atl,
    calculate_ctl,
    calculate_fitness_metrics,
    calculate_ramp_rate,
    calculate_readiness_score,
    calculate_tsb,
    compute_performance_model,
    estimate_days_to_peak,
    get_form_zone,
    get_readiness_level,
    is_ramp_rate_safe,
    predict_performance,
    recommend_taper_duration,
    srpe_to_tss,
    trimp_to_tss,
)


class TestCTL:
    """Tests for Chronic Training Load calculation."""

    def test_ctl_basic(self) -> None:
        """CTL calculation gives reasonable values."""
        today = date.today()
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50) for i in range(42)
        ]
        ctl = calculate_ctl(tss_values, today)
        assert ctl > 0
        assert ctl < 100  # Should be below daily TSS for constant load

    def test_ctl_increases_with_training(self) -> None:
        """More training increases CTL."""
        today = date.today()
        low_tss = [DailyTSS(date=today - timedelta(days=i), tss=30) for i in range(42)]
        high_tss = [DailyTSS(date=today - timedelta(days=i), tss=80) for i in range(42)]

        ctl_low = calculate_ctl(low_tss, today)
        ctl_high = calculate_ctl(high_tss, today)
        assert ctl_high > ctl_low


class TestATL:
    """Tests for Acute Training Load calculation."""

    def test_atl_basic(self) -> None:
        """ATL calculation gives reasonable values."""
        today = date.today()
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50) for i in range(14)
        ]
        atl = calculate_atl(tss_values, today)
        assert atl > 0

    def test_atl_responds_faster_than_ctl(self) -> None:
        """ATL responds faster to training changes."""
        today = date.today()
        # Low training then high training last 3 days
        tss_values = []
        for i in range(14, 3, -1):
            tss_values.append(DailyTSS(date=today - timedelta(days=i), tss=30))
        for i in range(3, -1, -1):
            tss_values.append(DailyTSS(date=today - timedelta(days=i), tss=100))

        atl = calculate_atl(tss_values, today)
        ctl = calculate_ctl(tss_values, today)
        # ATL should be higher because it responds faster to recent high training
        assert atl > ctl


class TestTSB:
    """Tests for Training Stress Balance."""

    def test_tsb_calculation(self) -> None:
        """TSB = CTL - ATL."""
        tsb = calculate_tsb(ctl=60, atl=50)
        assert tsb == 10

        tsb_negative = calculate_tsb(ctl=50, atl=70)
        assert tsb_negative == -20


class TestFormZones:
    """Tests for form zone classification."""

    def test_freshest_zone(self) -> None:
        """TSB > 25 is freshest."""
        assert get_form_zone(30) == FormZone.FRESHEST

    def test_fresh_zone(self) -> None:
        """TSB 10-25 is fresh."""
        assert get_form_zone(15) == FormZone.FRESH
        assert get_form_zone(25) == FormZone.FRESH

    def test_neutral_zone(self) -> None:
        """TSB -10 to 10 is neutral."""
        assert get_form_zone(0) == FormZone.NEUTRAL
        assert get_form_zone(9) == FormZone.NEUTRAL
        assert get_form_zone(-10) == FormZone.NEUTRAL

    def test_tired_zone(self) -> None:
        """TSB -25 to -10 is tired."""
        assert get_form_zone(-15) == FormZone.TIRED
        assert get_form_zone(-25) == FormZone.TIRED

    def test_exhausted_zone(self) -> None:
        """TSB < -25 is exhausted."""
        assert get_form_zone(-30) == FormZone.EXHAUSTED


class TestRampRate:
    """Tests for ramp rate calculation."""

    def test_ramp_rate_calculation(self) -> None:
        """Ramp rate is weekly CTL change."""
        today = date.today()
        # Increasing TSS over time
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50 + (42 - i))
            for i in range(50)
        ]
        ramp = calculate_ramp_rate(tss_values, today)
        assert ramp is not None

    def test_ramp_rate_safety(self) -> None:
        """Check if ramp rate is safe."""
        assert is_ramp_rate_safe(5.0)
        assert is_ramp_rate_safe(7.0)
        assert not is_ramp_rate_safe(10.0)


class TestReadiness:
    """Tests for readiness scoring."""

    def test_readiness_from_tsb(self) -> None:
        """Readiness score from TSB."""
        # Positive TSB = higher readiness
        high_readiness = calculate_readiness_score(tsb=20)
        low_readiness = calculate_readiness_score(tsb=-20)
        assert high_readiness > low_readiness

    def test_readiness_with_factors(self) -> None:
        """Readiness with multiple factors."""
        score = calculate_readiness_score(
            tsb=10,
            ramp_rate=5,
            hrv_score=80,
            sleep_quality=85,
            subjective_feeling=8,
        )
        assert 0 <= score <= 100

    def test_readiness_levels(self) -> None:
        """Readiness level classification."""
        assert get_readiness_level(90) == ReadinessLevel.OPTIMAL
        assert get_readiness_level(70) == ReadinessLevel.GOOD
        assert get_readiness_level(55) == ReadinessLevel.MODERATE
        assert get_readiness_level(40) == ReadinessLevel.LOW
        assert get_readiness_level(20) == ReadinessLevel.CRITICAL


class TestPerformancePrediction:
    """Tests for performance prediction."""

    def test_basic_prediction(self) -> None:
        """Performance = baseline + k1×CTL - k2×ATL."""
        perf = predict_performance(ctl=60, atl=50)
        # 100 + 1×60 - 2×50 = 60
        assert perf == 60.0

    def test_days_to_peak(self) -> None:
        """Estimate days to peak form."""
        days = estimate_days_to_peak(current_tsb=-10, target_tsb=20)
        assert days > 0

    def test_taper_recommendation(self) -> None:
        """Taper duration based on CTL."""
        short_taper = recommend_taper_duration(ctl=40)
        long_taper = recommend_taper_duration(ctl=120)
        assert short_taper < long_taper


class TestFitnessMetrics:
    """Tests for complete fitness metrics."""

    def test_complete_metrics(self) -> None:
        """calculate_fitness_metrics returns all fields."""
        today = date.today()
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50) for i in range(50)
        ]
        metrics = calculate_fitness_metrics(tss_values, today)

        assert metrics.ctl > 0
        assert metrics.atl > 0
        assert metrics.tsb is not None
        assert metrics.form_zone in FormZone


class TestTSSConversions:
    """Tests for TSS conversion utilities."""

    def test_srpe_to_tss(self) -> None:
        """sRPE load to TSS conversion."""
        # 60 min at RPE 5 = 300 sRPE = 50 TSS
        tss = srpe_to_tss(duration_min=60, rpe=5)
        assert tss == 50.0

    def test_trimp_to_tss(self) -> None:
        """TRIMP to TSS conversion."""
        tss = trimp_to_tss(trimp=100, ftp_trimp=100)
        assert tss == 100.0


class TestPerformanceModel:
    """Tests for complete performance model."""

    def test_complete_model(self) -> None:
        """compute_performance_model returns all fields."""
        today = date.today()
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50 + (i % 20))
            for i in range(60)
        ]
        model = compute_performance_model(tss_values, today)

        assert model.date == today
        assert model.ctl > 0
        assert model.atl > 0
        assert model.tsb is not None
        assert model.form_zone in FormZone
        assert 0 <= model.readiness_score <= 100
        assert model.readiness_level in ReadinessLevel
        assert model.predicted_performance is not None

    def test_coefficient_load_failure_falls_back_to_default_model(
        self, monkeypatch, caplog
    ) -> None:
        """A DB failure loading Banister coefficients is logged, not swallowed."""
        import arete.features.banister as banister

        def _raise(*args: object, **kwargs: object) -> None:
            raise RuntimeError("duckdb unavailable")

        monkeypatch.setattr(banister, "load_coefficients", _raise)
        today = date.today()
        tss_values = [
            DailyTSS(date=today - timedelta(days=i), tss=50 + (i % 20))
            for i in range(60)
        ]

        with caplog.at_level("ERROR"):
            model = compute_performance_model(tss_values, today)

        assert "Could not load Banister coefficients" in caplog.text
        assert model.predicted_performance is not None
