"""Tests for recommendations module."""

from arete.features.fitness import FormZone
from arete.features.recommendations import (
    Category,
    Priority,
    generate_recommendations,
    generate_week_plan,
)
from arete.features.workload import ACWRZone, MonotonyZone, StrainZone


class TestACWRRecommendations:
    """Tests for ACWR-based recommendations."""

    def test_danger_zone_critical_recommendation(self) -> None:
        """ACWR > 1.5 generates critical recommendation."""
        report = generate_recommendations(
            acwr=1.8,
            acwr_zone=ACWRZone.DANGER,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
        )
        critical_recs = [
            r for r in report.recommendations if r.priority == Priority.CRITICAL
        ]
        assert len(critical_recs) > 0
        assert report.risk_level == "high"
        # French text: a decimal comma.
        assert "Votre ACWR (1,80)" in critical_recs[0].message

    def test_optimal_zone_positive_feedback(self) -> None:
        """ACWR 0.8-1.3 generates positive feedback."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
        )
        # Should have low priority recommendation
        low_priority = [r for r in report.recommendations if r.priority == Priority.LOW]
        assert len(low_priority) > 0

    def test_undertrained_progression_suggestion(self) -> None:
        """ACWR < 0.8 suggests progression."""
        report = generate_recommendations(
            acwr=0.6,
            acwr_zone=ACWRZone.UNDERTRAINED,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
        )
        progression_recs = [
            r for r in report.recommendations if r.category == Category.PROGRESSION
        ]
        assert len(progression_recs) > 0


class TestMonotonyRecommendations:
    """Tests for monotony-based recommendations."""

    def test_high_monotony_variety_recommendation(self) -> None:
        """High monotony suggests variety."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=2.5,
            monotony_zone=MonotonyZone.HIGH,
            strain=None,
            strain_zone=None,
            sport_type="cardio",
        )
        variety_recs = [
            r for r in report.recommendations if r.category == Category.VARIETY
        ]
        assert len(variety_recs) > 0

    def test_strength_specific_variety(self) -> None:
        """Strength-specific variety recommendations."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=2.5,
            monotony_zone=MonotonyZone.HIGH,
            strain=None,
            strain_zone=None,
            sport_type="strength",
        )
        variety_recs = [
            r for r in report.recommendations if r.category == Category.VARIETY
        ]
        assert len(variety_recs) > 0
        # Should mention strength-specific suggestions
        assert any(
            "répétitions" in r.actions[0] or "lourdes" in r.actions[0]
            for r in variety_recs
        )


class TestStrainRecommendations:
    """Tests for strain-based recommendations."""

    def test_critical_strain_recovery_focus(self) -> None:
        """Critical strain emphasizes recovery."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=1.5,
            monotony_zone=MonotonyZone.ACCEPTABLE,
            strain=7000,
            strain_zone=StrainZone.CRITICAL,
        )
        recovery_recs = [
            r for r in report.recommendations if r.category == Category.RECOVERY
        ]
        assert len(recovery_recs) > 0
        assert any(r.priority == Priority.CRITICAL for r in recovery_recs)


class TestFormRecommendations:
    """Tests for TSB/form-based recommendations."""

    def test_exhausted_form_recovery(self) -> None:
        """Exhausted form triggers recovery recommendations."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
            tsb=-30,
            form_zone=FormZone.EXHAUSTED,
        )
        critical_recs = [
            r for r in report.recommendations if r.priority == Priority.CRITICAL
        ]
        assert len(critical_recs) > 0

    def test_fresh_form_performance(self) -> None:
        """Fresh form suggests performance opportunity."""
        report = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
            tsb=15,
            form_zone=FormZone.FRESH,
        )
        perf_recs = [
            r for r in report.recommendations if r.category == Category.PERFORMANCE
        ]
        assert len(perf_recs) > 0


class TestWeekPlan:
    """Tests for week plan generation."""

    def test_deload_when_danger(self) -> None:
        """Danger zone triggers deload."""
        plan = generate_week_plan(
            acwr_zone=ACWRZone.DANGER,
            strain_zone=None,
            form_zone=None,
            chronic_load=2000,
            sport_type="mixed",
        )
        assert plan.deload_recommended is True
        assert plan.target_sessions <= 2
        assert plan.target_load < 2000

    def test_progression_when_undertrained(self) -> None:
        """Undertrained zone allows progression."""
        plan = generate_week_plan(
            acwr_zone=ACWRZone.UNDERTRAINED,
            strain_zone=None,
            form_zone=None,
            chronic_load=1500,
            sport_type="mixed",
        )
        assert plan.deload_recommended is False
        assert plan.target_load > 1500

    def test_optimal_training(self) -> None:
        """Optimal zone maintains good training."""
        plan = generate_week_plan(
            acwr_zone=ACWRZone.OPTIMAL,
            strain_zone=StrainZone.OPTIMAL,
            form_zone=FormZone.NEUTRAL,
            chronic_load=2000,
            sport_type="cardio",
        )
        assert plan.deload_recommended is False
        assert plan.target_sessions >= 3


class TestRecommendationReport:
    """Tests for recommendation report structure."""

    def test_recommendations_sorted_by_priority(self) -> None:
        """Recommendations are sorted by priority."""
        report = generate_recommendations(
            acwr=1.8,
            acwr_zone=ACWRZone.DANGER,
            monotony=2.5,
            monotony_zone=MonotonyZone.HIGH,
            strain=7000,
            strain_zone=StrainZone.CRITICAL,
        )
        # Critical should come first
        if report.recommendations:
            first_rec = report.recommendations[0]
            assert first_rec.priority == Priority.CRITICAL

    def test_risk_level_assessment(self) -> None:
        """Risk level is correctly assessed."""
        high_risk = generate_recommendations(
            acwr=1.8,
            acwr_zone=ACWRZone.DANGER,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
        )
        assert high_risk.risk_level == "high"

        low_risk = generate_recommendations(
            acwr=1.0,
            acwr_zone=ACWRZone.OPTIMAL,
            monotony=1.0,
            monotony_zone=MonotonyZone.IDEAL,
            strain=2500,
            strain_zone=StrainZone.OPTIMAL,
        )
        assert low_risk.risk_level == "low"

    def test_primary_concern_identified(self) -> None:
        """Primary concern is identified."""
        report = generate_recommendations(
            acwr=1.8,
            acwr_zone=ACWRZone.DANGER,
            monotony=None,
            monotony_zone=None,
            strain=None,
            strain_zone=None,
        )
        assert report.primary_concern is not None
        assert "ALERTE" in report.primary_concern
