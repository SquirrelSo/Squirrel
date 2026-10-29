"""Profile details asked at sign-up: age, gender, activities, body measurements (BMI), physique
and habits.

Shaped after the agreed schema so it can move into the account service unchanged:

  * date of birth is stored, age is derived (a stored age is wrong within a year);
  * BMI is never stored: it is computed from the latest height and the latest weight in a
    measurement history, so it tracks progress without going stale;
  * what a user says they do (declared activities) lives here; what they actually do stays in the
    session captures;
  * physique and habits are sensitive: they are only stored while the user's consent for that
    category is granted, and withdrawing consent erases them.
"""
