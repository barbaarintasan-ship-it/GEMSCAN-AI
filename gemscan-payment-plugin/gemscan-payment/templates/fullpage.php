<?php
/**
 * GemScan — Full page template.
 * Renders ONLY the page content (the [gemscan_payment] shortcode) with no theme
 * header or footer, so the payment page is a clean stand-alone GemScan screen.
 */
if (!defined('ABSPATH')) {
    exit;
}
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?php echo esc_html(get_the_title()); ?></title>
    <?php wp_head(); ?>
    <style>
        html, body { margin: 0; padding: 0; background: #f7f2e7; }
        body.gemscan-fullpage { min-height: 100vh; }
        /* Belt-and-braces: hide any theme chrome that might still print. */
        body.gemscan-fullpage header.site-header,
        body.gemscan-fullpage .site-header,
        body.gemscan-fullpage #masthead,
        body.gemscan-fullpage footer.site-footer,
        body.gemscan-fullpage .site-footer,
        body.gemscan-fullpage #colophon { display: none !important; }
    </style>
</head>
<body <?php body_class('gemscan-fullpage'); ?>>
<?php
if (have_posts()) {
    while (have_posts()) {
        the_post();
        the_content();
    }
} else {
    echo do_shortcode('[gemscan_payment]');
}
wp_footer();
?>
</body>
</html>
