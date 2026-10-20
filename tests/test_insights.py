"""Every card sentence: right tone, numbers present, never raises on missing data."""

from __future__ import annotations

from arete.features import insights


class TestVolume:
    def test_spike_warns(self):
        r = insights.volume_insight(100, 70, 9.0)
        assert r["tone"] == "warn" and "+43 %" in r["text"]

    def test_controlled_progression_is_good(self):
        assert insights.volume_insight(105, 95, 8.0)["tone"] == "good"

    def test_drop_warns(self):
        assert insights.volume_insight(40, 100, 4.0)["tone"] == "warn"

    def test_without_comparison(self):
        r = insights.volume_insight(50, None, 5.0)
        assert r["tone"] == "neutral" and "50 km" in r["text"]

    def test_empty_period(self):
        assert "Aucune séance" in insights.volume_insight(0, 10, 0)["text"]


class TestPmc:
    def test_high_acwr_is_bad(self):
        assert insights.pmc_insight(90, -5, 1.6, "danger")["tone"] == "bad"

    def test_deep_fatigue_is_bad(self):
        assert insights.pmc_insight(90, -30, 1.0, "optimal")["tone"] == "bad"

    def test_rising_load_warns(self):
        assert insights.pmc_insight(90, -5, 1.35, "caution")["tone"] == "warn"

    def test_balanced_is_good(self):
        r = insights.pmc_insight(97, 3, 1.05, "optimal")
        assert r["tone"] == "good" and "optimal" in r["text"]
        assert r["text"].startswith("Forme de fond 97, fraîcheur +3.")

    def test_too_fresh_warns(self):
        assert insights.pmc_insight(50, 30, 0.6, "undertraining")["tone"] == "warn"


class TestZones:
    def test_polarised_is_good(self):
        r = insights.zones_insight(80.0, 15.0, 600)
        assert r["tone"] == "good" and "80 %" in r["text"]

    def test_too_much_middle_warns(self):
        assert insights.zones_insight(50.0, 25.0, 600)["tone"] == "warn"

    def test_not_enough_data(self):
        assert insights.zones_insight(None, None, 0)["tone"] == "neutral"
        assert insights.zones_insight(90.0, 5.0, 10)["tone"] == "neutral"


class TestSports:
    def test_single_sport(self):
        assert "Uniquement" in insights.sports_insight("course", 100.0, 1)["text"]

    def test_mix(self):
        assert "79 %" in insights.sports_insight("course", 79.3, 3)["text"]

    def test_nothing(self):
        assert "Aucune séance" in insights.sports_insight(None, None, 0)["text"]


class TestEconomy:
    def test_low_decoupling_is_good(self):
        r = insights.decoupling_insight(3.2, 12)
        assert r["tone"] == "good" and "3.2 %" in r["text"]

    def test_high_decoupling_warns(self):
        assert insights.decoupling_insight(14.0, 8)["tone"] == "warn"

    def test_no_runs(self):
        assert insights.decoupling_insight(None, 0)["tone"] == "neutral"

    def test_faster_is_good(self):
        r = insights.pace_insight(-6.0, 20)
        assert r["tone"] == "good" and "6 s/km" in r["text"]

    def test_slower_warns(self):
        assert insights.pace_insight(5.0, 20)["tone"] == "warn"

    def test_too_few_runs(self):
        assert insights.pace_insight(-10.0, 2)["tone"] == "neutral"


class TestRecovery:
    def test_readiness_up_and_down(self):
        assert insights.readiness_insight(72, 60)["tone"] == "good"
        assert insights.readiness_insight(50, 70)["tone"] == "warn"
        assert insights.readiness_insight(None, None)["tone"] == "neutral"

    def test_hrv(self):
        assert insights.hrv_insight(60, 50)["tone"] == "good"
        assert insights.hrv_insight(40, 60)["tone"] == "warn"
        assert insights.hrv_insight(None, 50)["tone"] == "neutral"

    def test_sleep(self):
        short = insights.sleep_insight(6 * 3600, 60)
        assert short["tone"] == "warn" and "6h00" in short["text"]
        assert insights.sleep_insight(8 * 3600, 85)["tone"] == "good"
        assert insights.sleep_insight(None, None)["tone"] == "neutral"

    def test_resting_hr_direction_is_inverted(self):
        assert insights.resting_hr_insight(55, 50)["tone"] == "warn"
        assert insights.resting_hr_insight(45, 50)["tone"] == "good"
        assert insights.resting_hr_insight(None, 50)["tone"] == "neutral"


class TestElevation:
    def test_terrain_from_running_ratio(self):
        r = insights.elevation_insight(800, None, 30)
        assert "montagneux" in r["text"] and "800 m D+" in r["text"]
        assert "plat" in insights.elevation_insight(80, None, 4)["text"]

    def test_no_running_ratio(self):
        assert "terrain" not in insights.elevation_insight(300, None, None)["text"]

    def test_empty(self):
        assert "Aucun dénivelé" in insights.elevation_insight(0, 200, None)["text"]


class TestCadence:
    def test_low_cadence_warns(self):
        assert insights.cadence_insight(152, None, 4)["tone"] == "warn"

    def test_shift_is_reported(self):
        assert "en baisse (-5)" in insights.cadence_insight(168, 173, 6)["text"]

    def test_stable(self):
        r = insights.cadence_insight(172, 171, 1)
        assert r["text"] == "Cadence médiane 172 pas/min sur 1 sortie."

    def test_empty(self):
        assert "Aucune cadence" in insights.cadence_insight(None, 170, 0)["text"]
