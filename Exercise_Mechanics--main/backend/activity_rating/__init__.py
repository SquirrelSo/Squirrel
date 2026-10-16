"""Activity Rating: the member's own rating of a session — how it felt and how they'd rate it.

User-generated, and kept strictly apart from the Workout Score (backend/reports/workout_score.py),
which is system-generated from the measured workout data. A rating never changes the score, and the
score never changes a rating. Stored beside the session it rates:

    data/users/<id>/sessions/<sid>/activity_rating.json
"""
